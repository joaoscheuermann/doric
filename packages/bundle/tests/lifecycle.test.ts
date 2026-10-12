// The host lifecycle the kernel runs for the bundles (M3): the start and stop
// steps through hooks/v1, the generation changes each live generation hears,
// and the peer signal between the generations. Real generation processes
// where a change crosses a process boundary.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { z } from 'zod';

import { defineHook } from '../src/contracts/define.js';
import {
  AppHooksV1,
  DoricStartupV1,
  HooksV1,
  type HostContext,
  ref,
} from '../src/contracts/index.js';
import type { StartupSink } from '../src/index.js';
import {
  contractsUrl,
  descriptorFor,
  embedded,
  manifest,
  withRoot,
  writeBundle,
} from './support/fixtures.js';
import { bootKernel, zodUrl } from './support/generation-fixtures.js';

interface Owner {
  readonly generation: number;
  readonly incarnation: number;
  readonly state?: string;
}

interface Change {
  readonly event: string;
  readonly generation: number;
  readonly incarnation: number;
  readonly self: Owner;
  readonly live: readonly Owner[];
  readonly holds?: readonly {
    readonly bundleId: string;
    readonly key: string;
  }[];
}

interface Signal {
  readonly topic: string;
  readonly payload: unknown;
  readonly from: {
    readonly bundleId: string;
    readonly generation: number;
    readonly incarnation: number;
  };
  readonly self: Owner;
  readonly live: readonly Owner[];
}

interface Watcher {
  seen(): Promise<{
    readonly changes: readonly Change[];
    readonly signals: readonly Signal[];
  }>;
  hold(key: string): Promise<null>;
  releaseAll(): Promise<null>;
  signal(topic: string): Promise<null>;
}

const WatcherV1 = ref<Watcher>('watcher/v1');
const ObserverV1 = ref<Watcher>('observer/v1');

/**
 * A plain-JS installed bundle, `watcher`: it records what its generation hears
 * (the generation changes and the peer signals), holds its generation on
 * request, and signals the other generations.
 */
const watcherSource = (id: string) => `
import { z } from ${JSON.stringify(zodUrl)};
import {
  AppHooksV1,
  defineMethod,
  defineService,
  DoricGenerationV1,
  HooksV1,
  ref,
} from ${JSON.stringify(contractsUrl)};

const WatcherV1 = ref(${JSON.stringify(`${id}/v1`)});
const changes = [];
const signals = [];
const holds = [];

export const activate = ({ services }) => {
  const hooks = services.use(HooksV1).use(AppHooksV1);

  hooks.onGenerationChangedHook((change) => {
    changes.push(change);
  });
  hooks.onPeerSignalHook((signal) => {
    signals.push(signal);
  });
  services.provide(
    defineService(WatcherV1, {
      seen: defineMethod({
        input: z.tuple([]),
        output: z.looseObject({}),
        execute: () => ({ changes: [...changes], signals: [...signals] }),
      }),
      hold: defineMethod({
        input: z.string(),
        output: z.null(),
        execute: (key, call) => {
          holds.push(services.use(DoricGenerationV1).hold({ key }, call));

          return null;
        },
      }),
      releaseAll: defineMethod({
        input: z.tuple([]),
        output: z.null(),
        execute: () => {
          for (const held of holds.splice(0)) held.dispose();

          return null;
        },
      }),
      signal: defineMethod({
        input: z.string(),
        output: z.null(),
        execute: async (topic, call) => {
          await services
            .use(DoricGenerationV1)
            .signal({ topic, payload: { from: 'watcher' } }, call);

          return null;
        },
      }),
    }),
  );
};
`;

const writeWatcher = async (
  root: string,
  version = '1.0.0',
  id = 'watcher',
) => {
  const source = manifest(id, {
    version,
    provides: [`${id}/v1@1.0.0`],
    requires: ['hooks/v1@^1.0.0'],
  });

  await writeBundle(join(root, 'bundles'), id, {
    manifest: source,
    descriptor: descriptorFor(source),
    host: watcherSource(id),
  });
};

/** A kernel-embedded bundle whose start and stop steps append to `log`. */
const stepper = (id: string, log: string[]) =>
  embedded(
    manifest(id, { requires: ['hooks/v1@^1.0.0'] }),
    ({ services }: HostContext) => {
      const hooks = services.use(HooksV1).use(AppHooksV1);

      hooks.onHostStartHook(async () => {
        log.push(`start:${id}`);
        await services.use(DoricStartupV1).log({
          level: 'info',
          fields: { bundle: id },
          message: `started ${id}`,
        });
      });
      hooks.onHostStopHook(() => {
        log.push(`stop:${id}`);
      });
    },
  );

const recordingStartup = () => {
  const stages: string[] = [];
  const lines: string[] = [];
  const sink: StartupSink = {
    stage: (name) => {
      stages.push(name);
    },
    log: (record) => {
      lines.push(record.message);
    },
  };

  return { sink, stages, lines };
};

/** Polls an async condition until it holds, failing with `what` otherwise. */
const until = async (check: () => Promise<boolean>, what: string) => {
  const started = Date.now();

  while (!(await check())) {
    if (Date.now() - started > 10_000) {
      assert.fail(`timed out: ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

void test('start steps run in activation order and stop steps in reverse, each awaited', async () => {
  await withRoot(async (root) => {
    const log: string[] = [];
    const startup = recordingStartup();
    const { platform } = await bootKernel(root, [], {
      embedded: [stepper('alpha', log), stepper('beta', log)],
      startup: startup.sink,
    });

    try {
      const order = platform
        .catalog()
        .order.filter((id) => id === 'alpha' || id === 'beta');

      assert.equal(order.length, 2);

      await platform.start();
      assert.deepEqual(
        log,
        order.map((id) => `start:${id}`),
      );
      assert.deepEqual(
        startup.lines,
        order.map((id) => `started ${id}`),
      );

      log.length = 0;
      await platform.shutdown();
      assert.deepEqual(
        log,
        [...order].reverse().map((id) => `stop:${id}`),
      );
    } finally {
      await platform.stop();
    }
  });
});

void test('a failing start step fails the start, and the stage it named is the one reported', async () => {
  await withRoot(async (root) => {
    const startup = recordingStartup();
    const failing = embedded(
      manifest('failing', { requires: ['hooks/v1@^1.0.0'] }),
      ({ services }: HostContext) => {
        services
          .use(HooksV1)
          .use(AppHooksV1)
          .onHostStartHook(async () => {
            await services.use(DoricStartupV1).stage('broken_step');
            throw new Error('the step broke');
          });
      },
    );
    const { platform } = await bootKernel(root, [], {
      embedded: [failing],
      startup: startup.sink,
    });

    try {
      await assert.rejects(platform.start(), /the step broke/);
      assert.deepEqual(startup.stages, ['broken_step']);
    } finally {
      await platform.stop();
    }
  });
});

void test('a stop step that fails is reported, and the platform still stops', async () => {
  await withRoot(async (root) => {
    const failing = embedded(
      manifest('failing', { requires: ['hooks/v1@^1.0.0'] }),
      ({ services }: HostContext) => {
        services
          .use(HooksV1)
          .use(AppHooksV1)
          .onHostStopHook(() => {
            throw new Error('cannot stop');
          });
      },
    );
    const { platform } = await bootKernel(root, [], {
      embedded: [failing],
    });

    await platform.start();
    await platform.shutdown();

    const reports = platform
      .diagnostics()
      .errors.filter(({ kind }) => kind === 'hook_execute_failed');

    assert.deepEqual(
      reports.map(({ message, details }) => ({ message, details })),
      [
        {
          message: 'cannot stop',
          details: { hook: 'onHostStopHook' },
        },
      ],
    );
    assert.equal(platform.mode, 'normal');
    await platform.stop();
  });
});

void test('only a sequence hook takes an order', () => {
  assert.throws(
    () =>
      defineHook({ kind: 'observe', input: z.object({}), order: 'reverse' }),
    /Only a sequence hook takes an order/,
  );
  assert.equal(
    defineHook({ kind: 'sequence', input: z.object({}), order: 'reverse' })
      .order,
    'reverse',
  );
});

void test('a generation change reaches every live generation, and a peer signal the other live ones', async () => {
  await withRoot(async (root) => {
    await writeWatcher(root);

    const { platform } = await bootKernel(root, ['watcher']);

    try {
      const first = platform.view(1).use(WatcherV1);

      // Boot is not a change: no generation hears of one.
      assert.deepEqual((await first.seen()).changes, []);
      await first.hold('keep');

      await writeWatcher(root, '1.1.0');
      assert.deepEqual(await platform.generations.publish(), {
        status: 'published',
        generation: 2,
      });

      const live = [
        { generation: 1, incarnation: 1, state: 'draining' },
        { generation: 2, incarnation: 1, state: 'active' },
      ];
      const drainingOf = (self: Owner) => ({
        event: 'draining',
        generation: 1,
        incarnation: 1,
        self,
        live,
      });
      const activatedOf = (self: Owner) => ({
        event: 'activated',
        generation: 2,
        incarnation: 1,
        self,
        live,
      });
      const one = { generation: 1, incarnation: 1 };
      const two = { generation: 2, incarnation: 1 };

      // Both live generations hear the drain of the first, then the switch.
      assert.deepEqual((await first.seen()).changes, [
        drainingOf(one),
        activatedOf(one),
      ]);
      const second = platform.view(2).use(WatcherV1);

      assert.deepEqual((await second.seen()).changes, [
        drainingOf(two),
        activatedOf(two),
      ]);

      // A signal of generation 1 reaches generation 2, named with its sender.
      await first.signal('ping');
      await until(
        async () => (await second.seen()).signals.length === 1,
        'the peer signal reaches the other live generation',
      );
      assert.deepEqual((await second.seen()).signals, [
        {
          topic: 'ping',
          payload: { from: 'watcher' },
          from: { bundleId: 'watcher', generation: 1, incarnation: 1 },
          self: two,
          live,
        },
      ]);
      assert.deepEqual((await first.seen()).signals, []);

      // Generation 1 ends with its hold; generation 2 hears it stop.
      await first.releaseAll();
      await until(
        async () => (await second.seen()).changes.at(-1)?.event === 'stopped',
        'the stop of generation 1 is reported',
      );
      assert.deepEqual((await second.seen()).changes.at(-1), {
        event: 'stopped',
        generation: 1,
        incarnation: 1,
        self: two,
        live: [{ generation: 2, incarnation: 1, state: 'active' }],
      });
    } finally {
      await platform.stop();
    }
  });
});

void test('a lost draining generation reports the holds it kept to the active one', async () => {
  await withRoot(async (root) => {
    await writeWatcher(root);

    const { platform } = await bootKernel(root, ['watcher']);

    try {
      await platform.view(1).use(WatcherV1).hold('keep');
      await writeWatcher(root, '1.1.0');
      await platform.generations.publish();

      const pid = platform.generations
        .describe()
        .find(({ generation }) => generation === 1)?.pid;

      assert.equal(typeof pid, 'number');
      process.kill(pid as number, 'SIGKILL');

      const active = platform.view(2).use(WatcherV1);

      await until(
        async () => (await active.seen()).changes.at(-1)?.event === 'lost',
        'the loss of generation 1 is reported to generation 2',
      );
      const lost = (await active.seen()).changes.at(-1);

      assert.equal(lost?.generation, 1);
      assert.deepEqual(lost?.holds, [{ bundleId: 'watcher', key: 'keep' }]);
      assert.deepEqual(lost?.live, [
        { generation: 2, incarnation: 1, state: 'active' },
      ]);
    } finally {
      await platform.stop();
    }
  });
});

void test('a lost generation hands each bundle only its own holds, and a peer signal stays with its bundle', async () => {
  await withRoot(async (root) => {
    await writeWatcher(root);
    await writeWatcher(root, '1.0.0', 'observer');

    const { platform } = await bootKernel(root, ['watcher', 'observer']);

    try {
      await platform.view(1).use(WatcherV1).hold('keep');
      await platform.view(1).use(ObserverV1).hold('mine');
      await writeWatcher(root, '1.1.0');
      assert.deepEqual(await platform.generations.publish(), {
        status: 'published',
        generation: 2,
      });

      // Generation 1 is draining and stays live, so the signal reaches generation 2.
      const watcher = platform.view(2).use(WatcherV1);
      const observer = platform.view(2).use(ObserverV1);

      await platform.view(1).use(WatcherV1).signal('watcher.ping');
      await until(
        async () => (await watcher.seen()).signals.length > 0,
        'the watcher bundle hears its own peer signal',
      );
      assert.deepEqual(
        (await observer.seen()).signals,
        [],
        'the observer bundle must not hear the watcher bundle signal',
      );

      const pid = platform.generations
        .describe()
        .find(({ generation }) => generation === 1)?.pid;

      assert.equal(typeof pid, 'number');
      process.kill(pid as number, 'SIGKILL');

      await until(
        async () => (await observer.seen()).changes.at(-1)?.event === 'lost',
        'the loss of generation 1 is reported to the observer bundle',
      );
      await until(
        async () => (await watcher.seen()).changes.at(-1)?.event === 'lost',
        'the loss of generation 1 is reported to the watcher bundle',
      );

      assert.deepEqual((await observer.seen()).changes.at(-1)?.holds, [
        { bundleId: 'observer', key: 'mine' },
      ]);
      assert.deepEqual((await watcher.seen()).changes.at(-1)?.holds, [
        { bundleId: 'watcher', key: 'keep' },
      ]);
    } finally {
      await platform.stop();
    }
  });
});
