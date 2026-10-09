import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  type Call,
  type CallScope,
  deadlineOf,
  defineMethod,
  defineService,
  generationOf,
  isContractError,
  ref,
} from '../src/contracts/index.js';
import {
  createPrincipal,
  emptyCatalogView,
  LayeredDirectory,
  ServiceDirectory,
  type ServiceRuntime,
  traceIdOf,
} from '../src/runtime/index.js';
import { flush, processes } from './support/envelope.js';

const codeOf = (expected: string) => (error: unknown) =>
  isContractError(error) && error.code === expected;

const spanOf = (call: Call): string =>
  call.trace.traceparent.split('-')[2] as string;

const seen: { call?: Call; release?: () => void } = {};

const probe = defineService('alpha.probe/v1', {
  who: defineMethod({
    input: z.tuple([]),
    output: z.object({ bundleId: z.string(), generation: z.number() }),
    execute: (_input, call) => {
      seen.call = call;

      return {
        bundleId: call.caller.bundleId,
        generation: call.caller.generation,
      };
    },
  }),
  wait: defineMethod({
    input: z.tuple([]),
    output: z.string(),
    execute: async (_input, call) => {
      seen.call = call;
      await new Promise<void>((done) => {
        if (call.signal.aborted) {
          done();
        } else {
          call.signal.addEventListener('abort', () => done(), { once: true });
        }
      });

      return 'late';
    },
  }),
  hang: defineMethod({
    input: z.tuple([]),
    output: z.string(),
    execute: () => new Promise<string>(() => undefined),
  }),
  range: defineMethod({
    input: z.tuple([z.number(), z.string().optional()]),
    output: z.array(z.unknown()),
    execute: (input) => [...input],
  }),
  even: defineMethod({
    input: z.object({ n: z.number().refine((n) => n % 2 === 0, 'not even') }),
    output: z.number(),
    execute: ({ n }) => n,
  }),
  broken: defineMethod({
    input: z.tuple([]),
    output: z.object({ ok: z.literal(true) }),
    execute: () => ({ ok: false }) as never,
  }),
  local: defineMethod({
    input: z.custom<() => void>((value) => typeof value === 'function'),
    output: z.void(),
    execute: () => undefined,
  }),
});

const ProbeV1 = ref<typeof probe>('alpha.probe/v1');

/** The kernel provides alpha.probe/v1; the generation sees it as remote. */
const withProbe = (options: { callerGeneration?: number } = {}) => {
  const world = processes(options);

  world.kernel.principal('alpha').services.provide(probe);
  world.kernel.expose('alpha.probe/v1');

  return world;
};

/** The same provider in one process: the in-process oracle. */
const inProcess = () => {
  const runtime: ServiceRuntime = {
    directory: new ServiceDirectory(),
    catalog: emptyCatalogView,
    environment: 'host',
    generation: 1,
    generationSignal: new AbortController().signal,
    report: () => undefined,
  };
  const principal = (bundleId: string) =>
    createPrincipal(runtime, {
      bundleId,
      version: '1.0.0',
      provides: 'any',
      requires: 'any',
    });

  principal('alpha').services.provide(probe);

  return principal('files').services.use(ProbeV1);
};

const rejection = async (run: () => unknown): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }

  assert.fail('expected a rejection');
};

void test('the provider sees the calling bundle, with the generation of the link', async () => {
  const world = withProbe({ callerGeneration: 99 });
  const stub = world.generation.principal('files').services.use(ProbeV1);

  assert.deepEqual(await stub.who(), { bundleId: 'files', generation: 2 });
  assert.equal(generationOf(seen.call as Call), 2);
});

void test('a forwarded parent call never carries the parent caller', async () => {
  const world = withProbe();
  const relay = defineService('alpha.relay/v1', {
    forward: defineMethod({
      input: z.tuple([]),
      output: z.object({ bundleId: z.string(), generation: z.number() }),
      execute: (_input, call, services) =>
        services.use(ProbeV1).who(call) as never,
    }),
  });

  world.kernel.principal('relay').services.provide(relay);
  world.kernel.expose('alpha.relay/v1');

  const stub = world.generation
    .principal('files')
    .services.use(ref<typeof relay>('alpha.relay/v1'));

  assert.deepEqual(await stub.forward(), { bundleId: 'relay', generation: 1 });
  // The pin of the chain is inherited through the kernel hop.
  assert.equal(generationOf(seen.call as Call), 2);
});

void test('a call whose generation the link never carried is a protocol error', async () => {
  const world = withProbe();
  const answers: unknown[] = [];

  world.transports.right.onMessage((message) => answers.push(message));
  world.transports.right.send({
    kind: 'call',
    id: 'g:forged',
    contract: 'alpha.probe/v1',
    method: 'who',
    input: [],
    caller: { bundleId: 'files', version: '1.0.0', generation: 2 },
    trace: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
    deadline: 0,
    generation: 5,
  });
  await flush();

  assert.deepEqual(
    answers.map((answer) => {
      const result = answer as {
        id: string;
        ok: boolean;
        error?: { code: string };
      };

      return { id: result.id, ok: result.ok, code: result.error?.code };
    }),
    [{ id: 'g:forged', ok: false, code: 'protocol_error' }],
  );
  assert.ok(
    world.kernel.reports.some((report) => report.kind === 'protocol_error'),
  );
});

void test('a malformed message is answered with protocol_error when it is a call', async () => {
  const world = withProbe();
  const answers: unknown[] = [];

  world.transports.right.onMessage((message) => answers.push(message));
  world.transports.right.send({
    kind: 'call',
    id: 'g:bad',
    contract: 'alpha.probe/v1',
  } as never);
  await flush();

  assert.equal((answers[0] as { ok: boolean }).ok, false);
  assert.equal(
    (answers[0] as { error: { code: string } }).error.code,
    'protocol_error',
  );
});

void test('scope merges and the trace continues with a new span per hop', async () => {
  const world = withProbe();
  const parents: Call[] = [];
  const local = defineService('files.local/v1', {
    start: defineMethod({
      input: z.tuple([]),
      output: z.object({ bundleId: z.string(), generation: z.number() }),
      execute: (_input, call, services) => {
        parents.push(call);

        return services
          .use(ProbeV1, { projectId: 'p1' } satisfies CallScope)
          .who(call) as never;
      },
    }),
  });
  const files = world.generation.principal('files');

  files.services.provide(local);

  await files.services
    .use(ref<typeof local>('files.local/v1'), { threadId: 't1' })
    .start();

  const parent = parents[0] as Call;
  const provider = seen.call as Call;

  assert.deepEqual(provider.scope, { threadId: 't1', projectId: 'p1' });
  assert.equal(traceIdOf(provider.trace), traceIdOf(parent.trace));
  assert.notEqual(spanOf(provider), spanOf(parent));
});

void test('aborting the caller signal aborts the provider; its late result still arrives', async () => {
  const world = withProbe();
  const stub = world.generation.principal('files').services.use(ProbeV1);
  const controller = new AbortController();
  const pending = stub.wait({ signal: controller.signal });

  await flush();
  assert.equal((seen.call as Call).signal.aborted, false);
  controller.abort();

  assert.equal(await pending, 'late');
  assert.equal((seen.call as Call).signal.aborted, true);
});

void test('the provider signal aborts with TimeoutError at the deadline; 0 means none', async () => {
  const world = withProbe();
  const stub = world.generation.principal('files').services.use(ProbeV1);
  const deadline = Date.now() + 30;

  assert.equal(await stub.wait({ deadline }), 'late');
  assert.equal(
    ((seen.call as Call).signal.reason as Error).name,
    'TimeoutError',
  );
  assert.equal(deadlineOf(seen.call as Call), deadline);

  await stub.who();
  assert.equal(deadlineOf(seen.call as Call), 0);
  await flush();
  assert.equal((seen.call as Call).signal.aborted, false);
});

void test('input and output validation keep the in-process codes and messages', async () => {
  const world = withProbe();
  const stub = world.generation.principal('files').services.use(ProbeV1);
  const local = inProcess();
  const sent = world.sentByGeneration.length;

  // Rejected by the JSON Schema before anything is sent.
  assert.throws(() => stub.even({ n: 'x' as never }), codeOf('invalid_input'));
  assert.equal(world.sentByGeneration.length, sent);

  // A zod-only refinement is rejected by the receiver, as in-process.
  const remoteRefusal = (await rejection(() => stub.even({ n: 3 }))) as Error;
  const localRefusal = (await rejection(() => local.even({ n: 3 }))) as Error;

  assert.ok(codeOf('invalid_input')(remoteRefusal));
  assert.equal(remoteRefusal.message, localRefusal.message);

  const remoteOutput = (await rejection(() => stub.broken())) as Error;
  const localOutput = (await rejection(() => local.broken())) as Error;

  assert.ok(codeOf('invalid_output')(remoteOutput));
  assert.equal(remoteOutput.message, localOutput.message);
});

void test('optional tuple items and trailing call options normalize as in-process', async () => {
  const world = withProbe();
  const stub = world.generation.principal('files').services.use(ProbeV1);
  const local = inProcess();
  const signal = new AbortController().signal;

  for (const args of [[1], [1, 'a'], [1, { signal }], [1, 'a', { signal }]]) {
    assert.deepEqual(
      await (stub.range as (...a: unknown[]) => unknown)(...args),
      await (local.range as (...a: unknown[]) => unknown)(...args),
    );
  }

  assert.throws(
    () => (stub.range as (...a: unknown[]) => unknown)(),
    codeOf('invalid_input'),
  );
});

void test('a bundle-defined local method cannot cross: local_only', () => {
  const world = withProbe();
  const stub = world.generation.principal('files').services.use(ProbeV1);

  assert.throws(() => stub.local(() => undefined), codeOf('local_only'));
});

void test('a closed link rejects pending calls with generation_lost and drops its records', async () => {
  const world = withProbe();
  const stub = world.generation.principal('files').services.use(ProbeV1);
  const pending = stub.hang();
  const local = defineService('files.api/v1', {
    ping: defineMethod({
      input: z.tuple([]),
      output: z.string(),
      execute: () => 'pong',
    }),
  });

  world.generation.principal('files').services.provide(local);
  world.generation.expose('files.api/v1');
  assert.equal(world.kernel.directory.providers('files.api/v1').length, 1);

  await flush();
  world.transports.sever();

  const error = (await rejection(() => pending)) as {
    code: string;
    details: unknown;
  };

  assert.equal(error.code, 'generation_lost');
  assert.deepEqual(error.details, { generation: 2, incarnation: 1 });
  assert.equal(world.kernel.directory.providers('files.api/v1').length, 0);
  // The remote record left the directory with the link.
  assert.throws(() => stub.who(), codeOf('unavailable'));
});

void test('a child whenAvailable fires for kernel providers; a kernel view loses a generation provider when it stops', async () => {
  const world = withProbe();
  const events: string[] = [];

  world.generation
    .principal('files')
    .services.whenAvailable(ProbeV1, (_api, provider) => {
      events.push(`child sees ${provider.bundleId}`);
    });

  const local = defineService('files.api/v1', {
    ping: defineMethod({
      input: z.tuple([]),
      output: z.string(),
      execute: () => 'pong',
    }),
  });

  world.generation.principal('files').services.provide(local);

  // The kernel sees the generation's records through a layered view.
  const overlay = new ServiceDirectory();
  const view = new LayeredDirectory(world.kernel.directory, overlay);
  const consumer = createPrincipal(
    { ...world.kernel.runtime, directory: view },
    {
      bundleId: 'transport',
      version: '1.0.0',
      provides: 'any',
      requires: 'any',
    },
  );
  const FilesApi = ref<typeof local>('files.api/v1');

  consumer.services.whenAvailable(FilesApi, (api) => {
    events.push('kernel sees files');
    void Promise.resolve(api.ping()).then((answer) =>
      events.push(`kernel got ${answer}`),
    );

    return () => {
      events.push('kernel lost files');
    };
  });

  const { registerRemote, describeRecord } = await import(
    '../src/runtime/envelope/index.js'
  );

  registerRemote(
    world.kernel.link,
    overlay,
    describeRecord(
      world.generation.directory.providers('files.api/v1')[0] as never,
    ),
  );
  await flush();
  world.transports.sever();
  await flush();

  assert.deepEqual(events, [
    'child sees alpha',
    'kernel sees files',
    'kernel got pong',
    'kernel lost files',
  ]);
});

const compiled = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

void test('runtime/envelope reaches only relative modules and zod', async () => {
  const seenFiles = new Set<string>();
  const bare = new Set<string>();
  const queue = [join(compiled, 'runtime', 'envelope', 'index.js')];

  while (queue.length > 0) {
    const file = queue.pop() as string;

    if (seenFiles.has(file)) {
      continue;
    }

    seenFiles.add(file);

    const source = await readFile(file, 'utf8');

    for (const match of source.matchAll(
      /(?:^|\s)(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    )) {
      const specifier = match[1] as string;

      if (specifier.startsWith('.')) {
        queue.push(join(dirname(file), specifier));
      } else {
        bare.add(specifier);
      }
    }
  }

  assert.deepEqual([...bare], ['zod']);
});
