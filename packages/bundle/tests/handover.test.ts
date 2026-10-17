// Generation handover at the platform level (57-WP-H): calls made while no
// generation is active wait for the next one (G-11), kernel providers that
// appear after boot reach running generations, and a draining generation's
// providers stay usable to the kernel bundles that hold them until it stops
// (G-1 item 5). Real forked generation processes, plain-JS bundles.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { z } from 'zod';

import {
  ContractError,
  defineMethod,
  defineService,
  type HostContext,
  ref,
  type Services,
} from '../src/contracts/index.js';
import type { KernelPlatform } from '../src/index.js';
import {
  contractsUrl,
  descriptorFor,
  embedded,
  manifest,
  withRoot,
  writeBundle,
} from './support/fixtures.js';
import {
  alive,
  bootKernel,
  eventually,
  writeProbe,
  zodUrl,
} from './support/generation-fixtures.js';

interface ProbeDescription {
  readonly generation: {
    readonly generation: number;
    readonly incarnation: number;
    readonly state: string;
  };
  readonly pid: number;
}

interface Probe {
  describe(options?: { signal?: AbortSignal }): Promise<ProbeDescription>;
  hold(promptId: string): Promise<null>;
  releaseAll(): Promise<null>;
  wait(ms: number): Promise<number>;
}

const ProbeV1 = ref<Probe>('probe/v1');

const pidOf = (platform: KernelPlatform, generation: number): number => {
  const pid = platform.generations
    .describe()
    .find((entry) => entry.generation === generation)?.pid;

  assert.equal(typeof pid, 'number');

  return pid as number;
};

void test('a kernel call made while no generation is active waits for the respawned one', async () => {
  await withRoot(async (root) => {
    await writeProbe(root);

    const { platform } = await bootKernel(root, ['probe']);

    try {
      const firstPid = pidOf(platform, 1);
      const probe = platform.services.use(ProbeV1);
      const window = new Promise<{
        readonly state: string | undefined;
        readonly waited: Promise<ProbeDescription>;
        readonly aborted: Promise<unknown>;
      }>((resolve) => {
        platform.generations.onLost(() => {
          // After the loss, before the respawned process is ready.
          setTimeout(() => {
            const controller = new AbortController();
            const aborted = probe.describe({ signal: controller.signal }).then(
              () => 'resolved',
              (error: unknown) => error,
            );

            controller.abort(new Error('caller gave up'));
            resolve({
              state: platform.generations.describe()[0]?.state,
              waited: probe.describe(),
              aborted,
            });
          }, 0);
        });
      });

      process.kill(firstPid, 'SIGKILL');

      const { state, waited, aborted } = await window;

      assert.equal(state, 'starting', 'the call starts in the respawn window');

      const described = await waited;

      assert.equal(described.generation.incarnation, 2);
      assert.notEqual(described.pid, firstPid);
      assert.equal(described.pid, pidOf(platform, 1));

      const reason = await aborted;

      assert.ok(reason instanceof Error);
      assert.equal(reason.message, 'caller gave up');
    } finally {
      await platform.stop();
    }

    // Once the host stops nothing waits: the call answers unavailable.
    await assert.rejects(
      async () => await platform.services.use(ProbeV1).describe(),
      (error: unknown) =>
        error instanceof ContractError && error.code === 'unavailable',
    );
  });
});

interface Late {
  ping(): string;
}

const LateV1 = ref<Late>('late/v1');

/** A generation bundle that calls the kernel contract `late/v1`. */
const writeCaller = (root: string) => {
  const source = manifest('caller', {
    provides: ['caller/v1@1.0.0'],
    requires: ['late/v1@^1.0.0'],
  });

  return writeBundle(join(root, 'bundles'), 'caller', {
    manifest: source,
    descriptor: descriptorFor(source),
    host: `
import { z } from ${JSON.stringify(zodUrl)};
import { defineMethod, defineService, ref } from ${JSON.stringify(contractsUrl)};

const LateV1 = ref('late/v1');

export const activate = ({ services }) => {
  services.provide(
    defineService(ref('caller/v1'), {
      ping: defineMethod({
        input: z.tuple([]),
        output: z.string(),
        execute: async () => await services.use(LateV1).ping(),
      }),
    }),
  );
};
`,
  });
};

/** The first value `read` resolves to that is not undefined (2 s at most). */
const settled = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + 2_000;

  for (;;) {
    const value = await read().catch(() => undefined);

    if (value !== undefined || Date.now() > deadline) {
      return value as T;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

interface Caller {
  ping(): Promise<string>;
}

const CallerV1 = ref<Caller>('caller/v1');

void test('a kernel provider registered after boot reaches the running generation, and its removal too', async () => {
  await withRoot(async (root) => {
    await writeCaller(root);

    let kernelServices: Services | undefined;
    const late = embedded(
      manifest('late', { provides: ['late/v1@1.0.0'] }),
      ({ services }: HostContext) => {
        kernelServices = services;
      },
    );
    const { platform } = await bootKernel(root, ['late', 'caller'], {
      embedded: [late],
    });

    try {
      const caller = platform.services.use(CallerV1);

      await assert.rejects(caller.ping(), (error: unknown) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.code, 'unavailable');
        assert.match(error.message, /late\/v1/);

        return true;
      });

      const registration = (kernelServices as Services).provide(
        defineService(LateV1, {
          ping: defineMethod({
            input: z.tuple([]),
            output: z.string(),
            execute: () => `pong from ${process.pid}`,
          }),
        }),
      );

      // The announcement crosses IPC: the generation sees it shortly after.
      assert.equal(
        await settled(() => caller.ping()),
        `pong from ${process.pid}`,
      );

      registration.dispose();

      const after = await settled(() =>
        caller.ping().then(
          () => undefined,
          (error: unknown) => error,
        ),
      );

      assert.ok(after instanceof ContractError);
      assert.equal(after.code, 'unavailable');
    } finally {
      await platform.stop();
    }
  });
});

void test('a kernel provider registered after boot reaches a generation published later', async () => {
  await withRoot(async (root) => {
    await writeCaller(root);

    let kernelServices: Services | undefined;
    const late = embedded(
      manifest('late', { provides: ['late/v1@1.0.0'] }),
      ({ services }: HostContext) => {
        kernelServices = services;
      },
    );
    const { platform } = await bootKernel(root, ['late', 'caller'], {
      embedded: [late],
    });

    try {
      (kernelServices as Services).provide(
        defineService(LateV1, {
          ping: defineMethod({
            input: z.tuple([]),
            output: z.string(),
            execute: () => 'pong',
          }),
        }),
      );
      assert.deepEqual(await platform.generations.publish(), {
        status: 'published',
        generation: 2,
      });
      assert.equal(await platform.view(2).use(CallerV1).ping(), 'pong');
    } finally {
      await platform.stop();
    }
  });
});

void test('a draining generation keeps the providers kernel bundles hold until it stops', async () => {
  await withRoot(async (root) => {
    await writeProbe(root);

    const seen: string[] = [];
    const held: Probe[] = [];
    const watcher = embedded(
      manifest('watcher', { requires: ['probe/v1@^1.0.0'] }),
      ({ services }: HostContext) => {
        services.whenAvailable(ProbeV1, (api) => {
          const index = held.push(api) - 1;

          seen.push(`added ${index}`);

          return () => {
            seen.push(`removed ${index}`);
          };
        });
      },
    );
    const { platform } = await bootKernel(root, ['probe', 'watcher'], {
      embedded: [watcher],
    });

    try {
      await eventually(() => held.length === 1, 'generation 1 is seen');

      const firstPid = pidOf(platform, 1);

      // A hold keeps generation 1 draining after the switch.
      await platform.view(1).use(ProbeV1).hold('prompt');
      await writeProbe(root, { version: '1.1.0' });
      assert.deepEqual(await platform.generations.publish(), {
        status: 'published',
        generation: 2,
      });
      await eventually(() => held.length === 2, 'generation 2 is seen');
      assert.deepEqual(seen, ['added 0', 'added 1']);

      // The draining generation's provider still answers its holder.
      const draining = await (held[0] as Probe).describe();

      assert.equal(draining.pid, firstPid);
      assert.notEqual((await (held[1] as Probe).describe()).pid, firstPid);
      // New callers resolve the active generation only.
      assert.notEqual(
        (await platform.services.use(ProbeV1).describe()).pid,
        firstPid,
      );

      await (held[0] as Probe).releaseAll();
      await eventually(
        () => platform.generations.describe()[0]?.state === 'stopped',
        'generation 1 stops once its hold ends',
      );
      await eventually(
        () => seen.includes('removed 0'),
        'the holder sees generation 1 go',
      );
      assert.deepEqual(seen, ['added 0', 'added 1', 'removed 0']);
      await eventually(() => !alive(firstPid), 'generation 1 process exits');
    } finally {
      await platform.stop();
    }
  });
});

void test('an activation listener can start a call that keeps the replaced generation draining', async () => {
  await withRoot(async (root) => {
    await writeProbe(root);

    const { platform } = await bootKernel(root, ['probe']);

    try {
      const firstPid = pidOf(platform, 1);
      let answer: Promise<number> | undefined;

      platform.generations.onActive((generation) => {
        if (generation === 2) {
          // No hold and no call in flight on generation 1 at this point.
          answer = platform.view(1).use(ProbeV1).wait(300);
        }
      });
      await writeProbe(root, { version: '1.1.0' });
      assert.deepEqual(await platform.generations.publish(), {
        status: 'published',
        generation: 2,
      });
      assert.equal(platform.generations.describe()[0]?.state, 'draining');
      assert.equal(await answer, firstPid);
      await eventually(
        () => platform.generations.describe()[0]?.state === 'stopped',
        'generation 1 stops once the call answers',
      );
    } finally {
      await platform.stop();
    }
  });
});
