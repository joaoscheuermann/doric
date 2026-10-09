// Real generation processes: the kernel forks the compiled runner and talks
// to it over Node IPC. Only processes are real doubles' boundaries here; the
// bundles are plain-JS fixtures and the core is the minimal test core.

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  AppHooksV1,
  type CatalogSnapshot,
  ContractError,
  type Diagnostics,
  DoricCatalogV1,
  HooksV1,
  type HostContext,
  ref,
  ToolsV1,
} from '../src/contracts/index.js';
import {
  defaultRunnerPath,
  type KernelPlatform,
  startHost,
} from '../src/index.js';
import {
  captureLog,
  captureSink,
  embedded,
  manifest,
  minimalCoreUrl,
  withRoot,
  writeBundle,
} from './support/fixtures.js';
import {
  acquire,
  alive,
  bootKernel,
  eventually,
  writeCrashOnActivate,
  writeDuplicateTool,
  writeProbe,
} from './support/generation-fixtures.js';
import { minimalCore } from './support/minimal-core.js';

interface ProbeDescription {
  readonly bundle: {
    readonly bundleId: string;
    readonly generation: number;
    readonly environment: string;
  };
  readonly generation: {
    readonly generation: number;
    readonly incarnation: number;
    readonly state: string;
  };
  readonly pid: number;
}

interface Probe {
  describe(): Promise<ProbeDescription>;
  hold(promptId: string): Promise<null>;
  releaseAll(): Promise<null>;
  wait(ms: number): Promise<number>;
}

const ProbeV1 = ref<Probe>('probe/v1');

const states = (diagnostics: Diagnostics | CatalogSnapshot) =>
  Object.fromEntries(diagnostics.bundles.map(({ id, state }) => [id, state]));

const pidOf = (platform: KernelPlatform, generation: number): number => {
  const pid = platform.generations
    .describe()
    .find((entry) => entry.generation === generation)?.pid;

  assert.equal(typeof pid, 'number');

  return pid as number;
};

const probeTool = (platform: KernelPlatform) => {
  const entry = platform.services
    .use(ToolsV1)
    .list()
    .find(({ tool }) => tool.name === 'probe');

  assert.ok(entry, 'the probe tool is registered in the kernel');

  return entry.tool;
};

void test('a generation process boots, serves its bundles and stops in order', async () => {
  await withRoot(async (root) => {
    await writeProbe(root, { tool: true });

    const { platform, log } = await bootKernel(root, ['probe']);

    try {
      const [generation] = platform.generations.describe();

      assert.equal(generation?.generation, 1);
      assert.equal(generation?.incarnation, 1);
      assert.equal(generation?.state, 'active');

      const pid = pidOf(platform, 1);

      assert.notEqual(pid, process.pid);
      assert.ok(alive(pid));

      // Published order: kernel partition, then the generation's bundles.
      const catalog = platform.catalog();

      assert.deepEqual(catalog.order, ['mincore', 'probe']);
      assert.deepEqual(states(catalog), { mincore: 'active', probe: 'active' });
      assert.deepEqual(states(platform.diagnostics()), {
        mincore: 'active',
        probe: 'active',
      });
      assert.equal(platform.services.use(DoricCatalogV1).get().generation, 1);

      // The tool registered in the child executes there, with its caller.
      const tool = probeTool(platform);
      const result = (await tool.execute({}, platform.call())) as {
        pid: number;
        generation: number;
      };

      assert.deepEqual(result, { pid, generation: 1 });

      // A provider of the generation, seen from the kernel's view of it.
      const described = await platform.view(1).use(ProbeV1).describe();

      assert.equal(described.pid, pid);
      assert.deepEqual(described.bundle, {
        bundleId: 'probe',
        version: '1.0.0',
        generation: 1,
        environment: 'host',
      });
      assert.deepEqual(described.generation, {
        generation: 1,
        incarnation: 1,
        state: 'active',
      });
      assert.deepEqual(
        log.lines.filter(({ level }) => level !== 'info'),
        [],
      );
    } finally {
      await platform.stop();
    }

    const [stopped] = platform.generations.describe();

    assert.equal(stopped?.state, 'stopped');
    await eventually(
      () => !alive(stopped?.pid as number),
      'the child exits after stop',
    );
  });
});

void test('a killed generation is reported lost before its pending calls reject, then respawns', async () => {
  await withRoot(async (root) => {
    await writeProbe(root, { tool: true });

    const { platform } = await bootKernel(root, ['probe']);

    try {
      const order: string[] = [];
      const lease = await acquire(platform, 'prompt-a');
      let lostExecutions: unknown;

      platform.generations.onLost((lost) => {
        order.push('lost');
        lostExecutions = lost;
      });

      const call = lease.call({});
      const pending = probeTool(platform)
        .execute({ block: true }, call)
        .then(
          () => order.push('resolved'),
          (error: unknown) => {
            order.push('rejected');

            return error;
          },
        );
      const activated = new Promise<number>((resolve) => {
        platform.generations.onActive(resolve);
      });
      const firstPid = pidOf(platform, 1);

      // Let the invocation reach the child before killing it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.kill(firstPid, 'SIGKILL');

      const error = await pending;

      assert.deepEqual(order, ['lost', 'rejected']);
      assert.ok(error instanceof ContractError);
      assert.equal((error as ContractError).code, 'generation_lost');
      assert.deepEqual(lostExecutions, {
        generation: 1,
        incarnation: 1,
        executions: [
          { projectId: 'project', threadId: 'thread', promptId: 'prompt-a' },
        ],
      });

      assert.equal(await activated, 1);

      const [respawned] = platform.generations.describe();

      assert.equal(respawned?.generation, 1);
      assert.equal(respawned?.incarnation, 2);
      assert.equal(respawned?.state, 'active');
      assert.notEqual(respawned?.pid, firstPid);
      // The lost execution no longer holds the generation; releasing is a no-op.
      assert.equal(respawned?.executions, 0);
      lease.release();

      const result = (await probeTool(platform).execute(
        {},
        platform.call(),
      )) as { pid: number };

      assert.equal(result.pid, respawned?.pid);
      assert.equal(
        (await platform.view(1).use(ProbeV1).describe()).generation.incarnation,
        2,
      );
    } finally {
      await platform.stop();
    }
  });
});

void test('a generation that keeps crashing at start is failed, its bundles quarantined, and the host keeps serving', async () => {
  await withRoot(async (root) => {
    await writeCrashOnActivate(root);

    const { platform, log } = await bootKernel(root, ['crasher']);

    try {
      const [generation] = platform.generations.describe();

      assert.equal(generation?.state, 'failed');
      assert.equal(generation?.incarnation, 3);

      const crasher = platform
        .diagnostics()
        .bundles.find(({ id }) => id === 'crasher');

      assert.equal(crasher?.state, 'quarantined');
      assert.deepEqual(
        crasher?.reasons.map(({ code }) => code),
        ['generation_failed'],
      );
      assert.match(
        crasher?.reasons[0]?.message ?? '',
        /^Generation 1 could not start: its process exited before it was ready \(code 1, signal null; code 1, signal null; code 1, signal null\)\.$/,
      );
      assert.equal(states(platform.catalog()).crasher, 'quarantined');
      assert.deepEqual(platform.services.use(ToolsV1).list(), []);
      assert.ok(
        log.lines.some(
          ({ level, message, fields }) =>
            level === 'warn' &&
            message === 'Bundle quarantined' &&
            fields.bundleId === 'crasher',
        ),
      );

      // Executions still acquire a (kernel-only) view.
      const lease = await acquire(platform, 'prompt-b');

      assert.equal(lease.generation, 1);
      lease.release();
    } finally {
      await platform.stop();
    }
  });
});

void test('a published generation replaces the active one, which drains until its holds end', async () => {
  await withRoot(async (root) => {
    await writeProbe(root);

    const { platform } = await bootKernel(root, ['probe']);

    try {
      const firstPid = pidOf(platform, 1);
      const lease = await acquire(platform, 'prompt-a');

      // A hold taken inside generation 1 through doric.generation/v1.
      await platform.view(1).use(ProbeV1).hold('prompt-b');
      await eventually(
        () => platform.generations.describe()[0]?.executions === 2,
        'both holds of generation 1 are counted',
      );

      await writeProbe(root, { version: '1.1.0' });

      const published = await platform.generations.publish();

      assert.deepEqual(published, { status: 'published', generation: 2 });
      assert.deepEqual(
        platform.generations
          .describe()
          .map(({ generation, state }) => ({ generation, state })),
        [
          { generation: 1, state: 'draining' },
          { generation: 2, state: 'active' },
        ],
      );
      assert.equal(platform.generation, 2);
      assert.equal(platform.catalog().generation, 2);
      assert.equal(
        platform.catalog().bundles.find(({ id }) => id === 'probe')?.version,
        '1.1.0',
      );

      // Each view keeps its own provider of the same `one` contract.
      const one = await platform.view(1).use(ProbeV1).describe();
      const two = await platform.view(2).use(ProbeV1).describe();

      assert.equal(one.pid, firstPid);
      assert.equal(one.generation.state, 'draining');
      assert.equal(two.bundle.generation, 2);
      assert.notEqual(two.pid, firstPid);

      // A new execution lands on generation 2.
      const next = await acquire(platform, 'prompt-c');

      assert.equal(next.generation, 2);
      next.release();

      lease.release();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(alive(firstPid), 'a hold inside generation 1 still drains it');

      await platform.view(1).use(ProbeV1).releaseAll();
      await eventually(
        () => platform.generations.describe()[0]?.state === 'stopped',
        'generation 1 stops once its last hold ends',
      );
      await eventually(() => !alive(firstPid), 'generation 1 process exits');
    } finally {
      await platform.stop();
    }
  });
});

void test('a draining generation without holds stops only after its calls in flight answer', async () => {
  await withRoot(async (root) => {
    await writeProbe(root);

    const { platform } = await bootKernel(root, ['probe']);

    try {
      const firstPid = pidOf(platform, 1);
      // A call into generation 1 without any execution lease.
      const answer = platform.view(1).use(ProbeV1).wait(600);

      await new Promise((resolve) => setTimeout(resolve, 50));
      await writeProbe(root, { version: '1.1.0' });
      assert.deepEqual(await platform.generations.publish(), {
        status: 'published',
        generation: 2,
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(platform.generations.describe()[0]?.state, 'draining');
      assert.ok(alive(firstPid), 'the call in flight keeps generation 1');

      assert.equal(await answer, firstPid);
      await eventually(
        () => platform.generations.describe()[0]?.state === 'stopped',
        'generation 1 stops once its last call answers',
      );
      await eventually(() => !alive(firstPid), 'generation 1 process exits');
    } finally {
      await platform.stop();
    }
  });
});

void test('a change to the kernel partition requires a restart', async () => {
  await withRoot(async (root) => {
    await writeProbe(root);

    const kernel = await bootKernel(root, ['probe']);
    const { platform } = kernel;

    try {
      // Another installed core is chosen: a kernel bundle changes.
      const core = minimalCore({ id: 'altcore' });

      await writeBundle(join(root, 'bundles'), 'altcore', {
        manifest: core.manifest,
        descriptor: core.descriptor,
        host: `export { activate } from ${JSON.stringify(minimalCoreUrl)};\n`,
      });
      await writeFile(
        kernel.compositionPath,
        JSON.stringify({
          core: 'altcore',
          enabled: ['mincore', 'altcore', 'probe'],
        }),
      );

      const published = await platform.generations.publish();

      assert.equal(published.status, 'kernel_restart_required');
      assert.deepEqual(
        platform.generations
          .describe()
          .map(({ generation, state }) => ({ generation, state })),
        [{ generation: 1, state: 'active' }],
      );
    } finally {
      await platform.stop();
    }
  });
});

void test('a generation process ignores SIGINT and ends when its kernel disconnects', async () => {
  await withRoot(async (root) => {
    await writeProbe(root, { tool: true });

    const { platform } = await bootKernel(root, ['probe']);

    try {
      const pid = pidOf(platform, 1);

      process.kill(pid, 'SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(alive(pid));
      assert.equal(platform.generations.describe()[0]?.state, 'active');
      assert.deepEqual(await probeTool(platform).execute({}, platform.call()), {
        pid,
        generation: 1,
      });
    } finally {
      await platform.stop();
    }
  });

  // An orphan (its kernel gone before init) exits on its own, with code 0.
  const child = fork(defaultRunnerPath(), [], {
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  child.disconnect();
  assert.equal(await exited, 0);
});

void test('a refused registration quarantines a generation bundle with the in-process reason', async () => {
  await withRoot(async (root) => {
    await writeProbe(root, { tool: true });
    await writeDuplicateTool(root);

    const single = await startHost({
      bundlesPath: join(root, 'bundles'),
      composition: {
        core: 'mincore',
        enabled: ['mincore', 'probe', 'dupe'],
        providers: {},
      },
      embedded: [minimalCore()],
      log: captureLog(),
      sink: captureSink(),
    });
    const pick = (diagnostics: Diagnostics) =>
      diagnostics.bundles
        .filter(({ id }) => id === 'probe' || id === 'dupe')
        .map(({ id, state, reasons }) => ({ id, state, reasons }));
    const expected = pick(single.diagnostics());

    await single.stop();

    const { platform } = await bootKernel(root, ['probe', 'dupe']);

    try {
      // Activation order is `dupe`, then `probe`: the second name is refused.
      assert.deepEqual(pick(platform.diagnostics()), expected);
      assert.deepEqual(expected, [
        { id: 'dupe', state: 'active', reasons: [] },
        {
          id: 'probe',
          state: 'quarantined',
          reasons: [
            {
              code: 'registration_failed',
              message:
                'Duplicate tool name "probe": bundle "dupe" and bundle "probe".',
            },
          ],
        },
      ]);
      assert.deepEqual(
        platform.services
          .use(ToolsV1)
          .list()
          .map(({ bundleId, tool }) => `${bundleId}:${tool.name}`),
        ['dupe:probe'],
      );
    } finally {
      await platform.stop();
    }
  });
});

void test('kernel hook handlers observe the activation of generation bundles', async () => {
  await withRoot(async (root) => {
    await writeProbe(root);

    const seen: unknown[] = [];
    const observer = embedded(
      manifest('observer', { requires: ['hooks/v1@^1.0.0'] }),
      ({ services }: HostContext) => {
        services
          .use(HooksV1)
          .use(AppHooksV1)
          .onActivateHook((input) => {
            seen.push(input);
          });
      },
    );
    const { platform } = await bootKernel(root, ['probe'], {
      embedded: [observer],
    });

    try {
      assert.deepEqual(platform.catalog().order, [
        'mincore',
        'observer',
        'probe',
      ]);
      await eventually(() => seen.length > 1, 'the activation hook ran');
      // As in-process: the observer sees itself, then the generation bundle.
      assert.deepEqual(seen, [
        {
          bundleId: 'observer',
          version: '1.0.0',
          generation: 1,
          environment: 'host',
        },
        {
          bundleId: 'probe',
          version: '1.0.0',
          generation: 1,
          environment: 'host',
        },
      ]);
    } finally {
      await platform.stop();
    }
  });
});
