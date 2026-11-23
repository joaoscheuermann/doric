// RK4's benchmark (spec `docs/designs/grpc-processes.md`, "Risks", RK4;
// AC2.2): latency and throughput of calls between bundle processes through
// the real platform (`startPlatform`: router, supervisor and gateway). Not a
// test: `tsconfig.spec.json` compiles it into `dist-tests` and
// `nx run bundle:bench-rk4` runs it with node.
//
// This one file is both the host and its fixture bundles: run without
// arguments it boots the platform, whose `commandOf` spawns this same file
// as `node rk4.js bundle <role> <dir>` for each bundle:
//
// - `echo` serves `rk4.echo/v1` (`Echo` answers its request; `Watch`
//   answers `Number(text)` items) and `rk4.sink/v1` (`Echo` answers the
//   request's length, so (e) transcodes the request, not a 100 KiB answer);
// - `relay` serves `rk4.relay/v1` by calling `rk4.echo/v1`: its `Echo` and
//   its `Watch`, item by item, are the second hop;
// - `core` serves `hooks/v1`. Phase 2 has no host-side `hooks/v1`, so this
//   provider is the nearest faithful equivalent: a `RegistrationTable` of
//   the handlers' `Register` calls, and a `Run` that calls each handler's
//   `HookHandlerService.Handle` with `doric-target`, one after the other in
//   their `order`, as a transform hook (each handler gets the previous
//   output; `Run` answers the last);
// - `hook-1` to `hook-5` register a handler of `rk4.bench/v1`'s `onBench`
//   in their activation and add 1 to the `Int32Value` they are given;
// - `caller` waits for the file `<dir>/go`, measures (a) to (d) with the
//   generated-at-run-time clients of the contracts above, and writes
//   `<dir>/results.json`.
//
// The host measures (e) itself through the gateway, shuts the platform down,
// checks that no bundle process is left, prints a table and, as its last
// line, the JSON summary, and applies RK4's rule: exit 1 when (a)'s p99
// passes 2 ms through one hop or 4 ms through two, or (d) stays under 5,000
// calls per second. `RK4_NO_FAIL=1` (or `--no-fail`) only reports.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { create, type DescService } from '@bufbuild/protobuf';
import { anyPack, anyUnpack, Int32ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  type Client,
  createClient,
  type ServiceImpl,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';

import {
  file_doric_hooks_v1_hooks,
  HookHandlerService,
  HooksService,
} from '../../src/contracts/gen/doric/hooks/v1/hooks_pb.js';
import {
  type HostContext,
  RegistrationTable,
  runBundle,
  type ServiceEntry,
  stampedCallerOf,
} from '../../src/index.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import { type Platform, startPlatform } from '../../src/platform/index.js';
import { instanceKey } from '../../src/platform/router/instances.js';
import { DiagnosticsStore } from '../../src/runtime/index.js';
import {
  type DemoClient,
  type DemoMessage,
  demoFile,
  serviceOf,
} from '../support/demo-contract.js';
import { resolveHost } from '../support/scripted-host.js';

// ---------------------------------------------------------------------------
// The workload

/** (a)'s message: 1 KiB of text. */
const kib = 'x'.repeat(1024);
/** (e)'s request body, `{"text":"…"}`: 102,400 bytes, the gateway's limit. */
const jsonText = 'a'.repeat(102_400 - 11);
/** (c)'s items per stream. */
const streamItems = 1_000;
/** (d)'s callers and measured seconds. */
const loadCallers = 64;
const loadSeconds = 10;
/** (b)'s handlers. */
const hookHandlers = 5;
const hooksContract = 'rk4.bench/v1';
const hookName = 'onBench';

/** Warm-up and measured iterations of each sequential measurement. */
const plan = {
  unary: { warmup: 2_000, measured: 10_000 },
  hooks: { warmup: 300, measured: 3_000 },
  stream: { warmup: 5, measured: 50 },
  gateway: { warmup: 100, measured: 1_000 },
  loadWarmupSeconds: 2,
};

const echoFile = demoFile({ id: 'rk4.echo/v1', package: 'rk4.echo.v1' });
const relayFile = demoFile({ id: 'rk4.relay/v1', package: 'rk4.relay.v1' });
const sinkFile = demoFile({ id: 'rk4.sink/v1', package: 'rk4.sink.v1' });
const EchoService = serviceOf(echoFile, 'DemoService');
const RelayService = serviceOf(relayFile, 'DemoService');
const SinkService = serviceOf(sinkFile, 'DemoService');

const hookIds = Array.from(
  { length: hookHandlers },
  (_, index) => `hook-${index + 1}`,
);

// ---------------------------------------------------------------------------
// Statistics

/** Latencies of one measurement, in milliseconds. */
interface Latency {
  readonly count: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly meanMs: number;
  readonly maxMs: number;
}

const round = (value: number): number => Math.round(value * 1_000) / 1_000;

/** The nearest-rank percentile `q` of ascending `sorted`. */
const percentile = (sorted: readonly number[], q: number): number =>
  sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;

const latencyOf = (samples: readonly number[]): Latency => {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);

  return {
    count: sorted.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p99Ms: round(percentile(sorted, 0.99)),
    meanMs: round(sum / sorted.length),
    maxMs: round(sorted.at(-1) ?? Number.NaN),
  };
};

/** Runs `call` `warmup` times, then times it `measured` times, one by one. */
const sequential = async (
  call: () => Promise<void>,
  counts: { readonly warmup: number; readonly measured: number },
): Promise<Latency> => {
  for (let index = 0; index < counts.warmup; index += 1) {
    await call();
  }

  const samples: number[] = [];

  for (let index = 0; index < counts.measured; index += 1) {
    const start = performance.now();

    await call();
    samples.push(performance.now() - start);
  }

  return latencyOf(samples);
};

/** (d)'s result: `callers` callers calling in a loop for `seconds`. */
interface Load extends Latency {
  readonly callers: number;
  readonly seconds: number;
  readonly callsPerSecond: number;
}

const loadOf = async (
  call: () => Promise<void>,
  callers: number,
  seconds: number,
): Promise<Load> => {
  const samples: number[] = [];
  const start = performance.now();
  const end = start + seconds * 1_000;
  const caller = async (): Promise<void> => {
    while (performance.now() < end) {
      const begin = performance.now();

      await call();
      samples.push(performance.now() - begin);
    }
  };

  await Promise.all(Array.from({ length: callers }, caller));

  const elapsed = (performance.now() - start) / 1_000;

  return {
    ...latencyOf(samples),
    callers,
    seconds: round(elapsed),
    callsPerSecond: Math.round(samples.length / elapsed),
  };
};

// ---------------------------------------------------------------------------
// The fixture bundles

/** A `DemoService` implementation; its messages are dynamic. */
interface DemoImplementation {
  echo(request: DemoMessage): Promise<DemoMessage> | DemoMessage;
  watch(request: DemoMessage): AsyncIterable<DemoMessage>;
  hidden(request: DemoMessage): DemoMessage;
}

// The demo contracts are built at run time, so their generated types are
// `DescService`'s; the tests type their clients and implementations by hand
// the same way (`tests/support/demo-contract.ts`).
const demoEntry = (
  service: DescService,
  implementation: DemoImplementation,
): ServiceEntry =>
  [
    service,
    implementation as unknown as ServiceImpl<DescService>,
  ] as ServiceEntry;

const demoClientOf = (context: HostContext, service: DescService): DemoClient =>
  context.services.use(service) as unknown as DemoClient;

/** `Number(request.text)` items. */
async function* items(request: DemoMessage): AsyncGenerator<DemoMessage> {
  const count = Number(request.text);

  for (let index = 0; index < count; index += 1) {
    yield { text: `item-${index}` };
  }

  await Promise.resolve();
}

const runEcho = (): void => {
  runBundle({
    services: [
      demoEntry(EchoService, {
        echo: (request) => ({ text: request.text }),
        watch: items,
        hidden: (request) => request,
      }),
      demoEntry(SinkService, {
        echo: (request) => ({ text: String(request.text.length) }),
        watch: items,
        hidden: (request) => request,
      }),
    ],
    activate: () => {},
  });
};

const runRelay = (): void => {
  let echo: DemoClient | undefined;
  const echoOf = (): DemoClient => {
    if (echo === undefined) {
      throw new Error('The relay is not active.');
    }

    return echo;
  };

  runBundle({
    services: [
      demoEntry(RelayService, {
        echo: (request) => echoOf().echo(request),
        watch: async function* (request) {
          for await (const item of echoOf().watch(request)) {
            yield item;
          }
        },
        hidden: (request) => request,
      }),
    ],
    activate: (context) => {
      echo = demoClientOf(context, EchoService);
    },
  });
};

/** `core`: a `hooks/v1` provider (see the header). */
const runHooksProvider = (): void => {
  const table = new RegistrationTable<number>({
    conflictCode: 'registration_conflict',
  });
  const handlers = new Map<string, Client<typeof HookHandlerService>>();
  let services: HostContext['services'] | undefined;
  const handlerOf = (target: string): Client<typeof HookHandlerService> => {
    if (services === undefined) {
      throw new Error('The hooks provider is not active.');
    }

    const client =
      handlers.get(target) ?? services.use(HookHandlerService, { target });

    handlers.set(target, client);

    return client;
  };
  let definitions = 0;

  runBundle({
    services: [
      [
        HooksService,
        {
          define: () => {
            definitions += 1;

            return { registrationId: `d${definitions}` };
          },
          register: (request, context) => {
            const caller = stampedCallerOf(context);

            return table.register(
              caller,
              `${request.contract}\u0000${request.hook}\u0000${caller.bundleId}`,
              request.order ?? Number.MAX_SAFE_INTEGER,
            );
          },
          unregister: (request) => {
            table.remove(request.registrationId);

            return {};
          },
          run: async (request) => {
            const prefix = `${request.contract}\u0000${request.hook}\u0000`;
            const entries = table
              .entries()
              .filter(({ key }) => key.startsWith(prefix))
              .sort((a, b) => a.value - b.value);
            let input = request.input;

            for (const entry of entries) {
              const target = instanceKey(entry.caller);
              const answer = await handlerOf(target).handle({
                contract: request.contract,
                hook: request.hook,
                input,
              });

              input = answer.output ?? input;
            }

            return input === undefined ? {} : { output: input };
          },
          watchAvailability: async function* () {
            yield { available: true };
            await Promise.resolve();
          },
        },
      ],
    ],
    activate: (context) => {
      services = context.services;
      context.instances.onGone((instance) => table.dropInstance(instance));
    },
  });
};

const runHookHandler = (order: number): void => {
  runBundle({
    services: [
      [
        HookHandlerService,
        {
          handle: (request) => {
            const value =
              request.input === undefined
                ? undefined
                : anyUnpack(request.input, Int32ValueSchema);

            return {
              output: anyPack(
                Int32ValueSchema,
                create(Int32ValueSchema, { value: (value?.value ?? 0) + 1 }),
              ),
            };
          },
        },
      ],
    ],
    activate: async (context) => {
      await context.registrations.track(HooksService, (client) =>
        client.register({ contract: hooksContract, hook: hookName, order }),
      );
    },
  });
};

/** What `caller` measures and writes to `results.json`. */
interface CallerResults {
  readonly unaryOneHop: Latency;
  readonly unaryTwoHops: Latency;
  readonly hooksRun: Latency & { readonly handlers: number };
  readonly streamTwoHops: Latency & {
    readonly items: number;
    readonly itemsPerSecond: number;
  };
  readonly concurrentOneHop: Load;
  readonly concurrentTwoHops: Load;
}

type CallerOutcome =
  | { readonly ok: true; readonly results: CallerResults }
  | { readonly ok: false; readonly error: string };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const measure = async (context: HostContext): Promise<CallerResults> => {
  const echo = demoClientOf(context, EchoService);
  const relay = demoClientOf(context, RelayService);
  const hooks = context.services.use(HooksService);
  const unary = (client: DemoClient) => async (): Promise<void> => {
    const answer = await client.echo({ text: kib });

    if (answer.text.length !== kib.length) {
      throw new Error(`echo answered ${answer.text.length} characters`);
    }
  };
  const hookInput = anyPack(
    Int32ValueSchema,
    create(Int32ValueSchema, { value: 0 }),
  );
  const runHooks = async (): Promise<void> => {
    const answer = await hooks.run({
      contract: hooksContract,
      hook: hookName,
      input: hookInput,
    });
    const output =
      answer.output === undefined
        ? undefined
        : anyUnpack(answer.output, Int32ValueSchema);

    if (output?.value !== hookHandlers) {
      throw new Error(`Run ran ${output?.value ?? 0} handlers`);
    }
  };
  const stream = async (): Promise<void> => {
    let items = 0;

    for await (const _ of relay.watch({ text: String(streamItems) })) {
      items += 1;
    }

    if (items !== streamItems) {
      throw new Error(`the stream answered ${items} items`);
    }
  };

  const unaryOneHop = await sequential(unary(echo), plan.unary);
  const unaryTwoHops = await sequential(unary(relay), plan.unary);
  const hooksRun = await sequential(runHooks, plan.hooks);
  const streamTwoHops = await sequential(stream, plan.stream);

  await loadOf(unary(echo), loadCallers, plan.loadWarmupSeconds);

  const concurrentOneHop = await loadOf(unary(echo), loadCallers, loadSeconds);

  await loadOf(unary(relay), loadCallers, plan.loadWarmupSeconds);

  const concurrentTwoHops = await loadOf(
    unary(relay),
    loadCallers,
    loadSeconds,
  );

  return {
    unaryOneHop,
    unaryTwoHops,
    hooksRun: { ...hooksRun, handlers: hookHandlers },
    streamTwoHops: {
      ...streamTwoHops,
      items: streamItems,
      itemsPerSecond: Math.round(streamItems / (streamTwoHops.p50Ms / 1_000)),
    },
    concurrentOneHop,
    concurrentTwoHops,
  };
};

const runCaller = (dir: string): void => {
  const write = (outcome: CallerOutcome): void => {
    const partial = join(dir, 'results.json.partial');

    writeFileSync(partial, JSON.stringify(outcome));
    renameSync(partial, join(dir, 'results.json'));
  };

  runBundle({
    activate: (context) => {
      void (async () => {
        while (!existsSync(join(dir, 'go'))) {
          await sleep(20);
        }

        try {
          write({ ok: true, results: await measure(context) });
        } catch (error) {
          write({ ok: false, error: String(error) });
        }
      })();
    },
  });
};

const runRole = (role: string, dir: string): void => {
  if (role === 'echo') {
    runEcho();
  } else if (role === 'relay') {
    runRelay();
  } else if (role === 'core') {
    runHooksProvider();
  } else if (role === 'caller') {
    runCaller(dir);
  } else if (hookIds.includes(role)) {
    runHookHandler(hookIds.indexOf(role) + 1);
  } else {
    throw new Error(`Unknown rk4 role ${role}.`);
  }
};

// ---------------------------------------------------------------------------
// The host

const self = fileURLToPath(import.meta.url);

/** The bundles, `core` aside (`resolveHost` adds it, providing `hooks/v1`). */
const bundles = () => {
  // `mode` is the scripted fixture's; unused, since `commandOf` runs rk4.
  const base = { mode: 'alive' } as const;
  const hooks = 'hooks/v1@^1.0.0';

  return {
    echo: {
      ...base,
      provides: ['rk4.echo/v1@1.0.0', 'rk4.sink/v1@1.0.0'],
    },
    relay: {
      ...base,
      provides: ['rk4.relay/v1@1.0.0'],
      requires: ['rk4.echo/v1@^1.0.0'],
    },
    ...Object.fromEntries(
      hookIds.map((id) => [id, { ...base, requires: [hooks] }]),
    ),
    caller: {
      ...base,
      requires: ['rk4.echo/v1@^1.0.0', 'rk4.relay/v1@^1.0.0', hooks],
    },
  };
};

/** The pids of this run's bundle processes still alive (their args hold `dir`). */
const leftoverPids = (dir: string): number[] =>
  execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(self) && line.includes(dir))
    .map((line) => Number.parseInt(line.trim(), 10));

const waitForResults = async (dir: string): Promise<CallerResults> => {
  const path = join(dir, 'results.json');
  const deadline = performance.now() + 10 * 60_000;

  while (!existsSync(path)) {
    if (performance.now() > deadline) {
      throw new Error('The caller wrote no results within 10 minutes.');
    }

    await sleep(100);
  }

  const outcome: CallerOutcome = JSON.parse(readFileSync(path, 'utf8'));

  if (!outcome.ok) {
    throw new Error(`The caller failed: ${outcome.error}`);
  }

  return outcome.results;
};

/** (e): a 100 KiB request through the gateway, in Connect JSON and binary. */
interface GatewayResults {
  readonly requestBytes: number;
  readonly json: Latency;
  readonly binary: Latency;
  /** JSON's p50 minus binary's: the transcoding's share. */
  readonly transcodingP50Ms: number;
}

const measureGateway = async (port: number): Promise<GatewayResults> => {
  const clientOf = (useBinaryFormat: boolean): DemoClient =>
    createClient(
      SinkService,
      createConnectTransport({
        baseUrl: `http://127.0.0.1:${port}`,
        httpVersion: '1.1',
        useBinaryFormat,
      }),
    ) as unknown as DemoClient;
  const call = (client: DemoClient) => async (): Promise<void> => {
    const answer = await client.echo({ text: jsonText });

    if (answer.text !== String(jsonText.length)) {
      throw new Error(`the sink answered ${answer.text}`);
    }
  };
  const json = await sequential(call(clientOf(false)), plan.gateway);
  const binary = await sequential(call(clientOf(true)), plan.gateway);

  return {
    requestBytes: JSON.stringify({ text: jsonText }).length,
    json,
    binary,
    transcodingP50Ms: round(json.p50Ms - binary.p50Ms),
  };
};

interface Summary {
  readonly benchmark: 'rk4';
  readonly machine: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly cpus: number;
    readonly cpuModel: string;
  };
  readonly a: { readonly oneHop: Latency; readonly twoHops: Latency };
  readonly b: CallerResults['hooksRun'];
  readonly c: CallerResults['streamTwoHops'];
  readonly d: { readonly oneHop: Load; readonly twoHops: Load };
  readonly e: GatewayResults;
  readonly rule: {
    readonly oneHopP99Ms: { readonly limit: 2; readonly pass: boolean };
    readonly twoHopsP99Ms: { readonly limit: 4; readonly pass: boolean };
    readonly callsPerSecond: { readonly limit: 5_000; readonly pass: boolean };
    readonly pass: boolean;
  };
  readonly leftoverProcesses: number;
}

const ruleOf = (
  a: Summary['a'],
  d: Summary['d'],
  leftovers: number,
): Summary['rule'] => {
  const oneHop = a.oneHop.p99Ms <= 2;
  const twoHops = a.twoHops.p99Ms <= 4;
  const throughput = d.oneHop.callsPerSecond >= 5_000;

  return {
    oneHopP99Ms: { limit: 2, pass: oneHop },
    twoHopsP99Ms: { limit: 4, pass: twoHops },
    callsPerSecond: { limit: 5_000, pass: throughput },
    pass: oneHop && twoHops && throughput && leftovers === 0,
  };
};

const tableOf = (summary: Summary): string => {
  const row = (name: string, latency: Latency, extra = ''): string =>
    `${name.padEnd(46)}${latency.p50Ms.toFixed(3).padStart(9)}${latency.p99Ms
      .toFixed(3)
      .padStart(9)}  ${extra}`;
  const verdict = (pass: boolean): string => (pass ? 'pass' : 'FAIL');
  const { machine, a, b, c, d, e, rule } = summary;

  return [
    `RK4 on node ${machine.node}, ${machine.platform} ${machine.arch}, ${machine.cpus} CPUs (${machine.cpuModel})`,
    `${'measurement'.padEnd(46)}${'p50 ms'.padStart(9)}${'p99 ms'.padStart(9)}`,
    row('(a) unary 1 KiB, one hop', a.oneHop),
    row('(a) unary 1 KiB, two hops', a.twoHops),
    row(`(b) hooks/v1.Run, ${b.handlers} handlers`, b),
    row(
      `(c) stream of ${c.items} items, two hops`,
      c,
      `${c.itemsPerSecond} items/s at p50`,
    ),
    row(
      `(d) ${d.oneHop.callers} callers of (a) one hop, ${d.oneHop.seconds} s`,
      d.oneHop,
      `${d.oneHop.callsPerSecond} calls/s`,
    ),
    row(
      `(d) ${d.twoHops.callers} callers of (a) two hops, ${d.twoHops.seconds} s`,
      d.twoHops,
      `${d.twoHops.callsPerSecond} calls/s`,
    ),
    row(`(e) gateway, ${e.requestBytes} B Connect JSON`, e.json),
    row(`(e) gateway, same request in Connect binary`, e.binary),
    `(e) transcoding's share of the p50: ${e.transcodingP50Ms.toFixed(3)} ms`,
    `rule: (a) one hop p99 <= 2 ms ${verdict(rule.oneHopP99Ms.pass)}; (a) two hops p99 <= 4 ms ${verdict(rule.twoHopsP99Ms.pass)}; (d) >= 5000 calls/s ${verdict(rule.callsPerSecond.pass)}; leftover processes ${summary.leftoverProcesses}`,
    `RK4 rule: ${verdict(rule.pass)}`,
  ].join('\n');
};

const main = async (): Promise<number> => {
  const reportOnly =
    process.env.RK4_NO_FAIL === '1' || process.argv.includes('--no-fail');
  const dir = mkdtempSync(join(tmpdir(), 'doric-rk4-'));
  const resolved = resolveHost(bundles());
  const diagnostics = new DiagnosticsStore({ generation: 1 });
  const quarantines: string[] = [];
  let platform: Platform | undefined;

  diagnostics.load(resolved);

  try {
    platform = await startPlatform({
      index: createCatalogIndex([
        file_doric_hooks_v1_hooks,
        echoFile,
        relayFile,
        sinkFile,
      ]),
      publicAddress: '127.0.0.1:0',
      resolved,
      commandOf: (bundleId) => ({
        command: process.execPath,
        args: [self, 'bundle', bundleId, dir],
      }),
      env: { PATH: process.env.PATH },
      diagnostics,
      exit: (code) => {
        quarantines.push(`exit ${code}`);
      },
      onQuarantine: (bundleId, reason) => {
        quarantines.push(`${bundleId} ${reason.code}`);
      },
      writeLog: () => {},
    });

    if (quarantines.length > 0) {
      throw new Error(`Quarantined at boot: ${quarantines.join(', ')}`);
    }

    writeFileSync(join(dir, 'go'), '');

    const results = await waitForResults(dir);
    const gateway = await measureGateway(platform.publicPort ?? 0);

    await platform.shutdown();
    platform = undefined;

    const leftovers = leftoverPids(dir);
    const a = { oneHop: results.unaryOneHop, twoHops: results.unaryTwoHops };
    const d = {
      oneHop: results.concurrentOneHop,
      twoHops: results.concurrentTwoHops,
    };
    const summary: Summary = {
      benchmark: 'rk4',
      machine: {
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        cpus: availableParallelism(),
        cpuModel: cpus()[0]?.model ?? 'unknown',
      },
      a,
      b: results.hooksRun,
      c: results.streamTwoHops,
      d,
      e: gateway,
      rule: ruleOf(a, d, leftovers.length),
      leftoverProcesses: leftovers.length,
    };

    process.stdout.write(`${tableOf(summary)}\n${JSON.stringify(summary)}\n`);

    if (quarantines.length > 0) {
      process.stderr.write(`Quarantines: ${quarantines.join(', ')}\n`);

      return 1;
    }

    if (leftovers.length > 0) {
      process.stderr.write(`Bundle processes left: ${leftovers.join(', ')}\n`);

      return 1;
    }

    return summary.rule.pass || reportOnly ? 0 : 1;
  } finally {
    await platform?.shutdown();

    for (const pid of leftoverPids(dir)) {
      process.kill(pid, 'SIGKILL');
    }

    rmSync(dir, { recursive: true, force: true });
  }
};

const [kind, role, dir] = process.argv.slice(2);

if (kind === 'bundle' && role !== undefined && dir !== undefined) {
  runRole(role, dir);
} else {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`RK4 failed: ${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
