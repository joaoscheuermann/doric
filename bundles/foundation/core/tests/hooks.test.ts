import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppHooksV1,
  type Call,
  type CallArg,
  defineHook,
  defineHooks,
  defineMethod,
  defineService,
  type HookHandle,
  HooksV1,
  isContractError,
  ref,
  type Services,
} from 'bundle/contracts';
import { z } from 'zod';

import {
  boot,
  core,
  errorKinds,
  probe,
  reasonCodes,
  states,
} from './support/host.js';

/** A hooks contract owned by the `owner` probe. */
const OwnerHooksV1 = defineHooks('owner.hooks/v1', {
  onNoticeHook: defineHook({
    kind: 'observe',
    input: z.object({ text: z.string() }).strict(),
  }),
  onShapeHook: defineHook({
    kind: 'transform',
    input: z.object({ value: z.number() }).strict(),
  }),
  onAllowHook: defineHook({ kind: 'decide', input: z.object({}).strict() }),
});

/** A service of `owner` that runs its hooks for the test. */
const OwnerRunV1 = ref<{
  notice(text: string, call?: CallArg): Promise<void>;
  shape(value: number, call?: CallArg): Promise<{ value: number }>;
  allow(call?: CallArg): Promise<{ allow: boolean; reason?: string }>;
}>('owner.run/v1');

const usesHooks = ['hooks/v1@^1.0.0'];

/** A consumer that registers with `hooks.use` lists the hooks contract too. */
const consumesOwnerHooks = [...usesHooks, 'owner.hooks/v1@^1.0.0'];

/** The owner defines its hooks during activation and runs them on request. */
const owner = () => {
  let handle: HookHandle<typeof OwnerHooksV1> | undefined;

  return probe('owner', {
    requires: usesHooks,
    provides: [
      ['owner.hooks/v1', 'hooks'],
      ['owner.run/v1', 'service'],
    ],
    activate: ({ services }) => {
      handle = services.use(HooksV1).define(OwnerHooksV1);
      services.provide(
        defineService('owner.run/v1', {
          notice: defineMethod({
            input: z.string(),
            output: z.void(),
            execute: async (text) => {
              await handle?.onNoticeHook.execute({ text });
            },
          }),
          shape: defineMethod({
            input: z.number(),
            output: z.object({ value: z.number() }),
            execute: async (value) =>
              (await handle?.onShapeHook.execute({ value })) ?? { value },
          }),
          allow: defineMethod({
            input: z.tuple([]),
            output: z.object({
              allow: z.boolean(),
              reason: z.string().optional(),
            }),
            execute: async () =>
              (await handle?.onAllowHook.execute({})) ?? { allow: true },
          }),
        }),
      );
    },
  });
};

const listener = (
  id: string,
  register: (hooks: ReturnType<typeof registrar>) => void,
) =>
  probe(id, {
    requires: consumesOwnerHooks,
    activate: ({ services }) => register(registrar(services)),
  });

const registrar = (services: Services) =>
  services.use(HooksV1).use(OwnerHooksV1);

void test('observe handlers run in catalog order, each with the call the owner made', async () => {
  const seen: { bundle: string; caller: string }[] = [];
  const record = (bundle: string) => (_input: unknown, call: Call) => {
    seen.push({ bundle, caller: call.caller.bundleId });
  };
  // Both consumers require owner.hooks/v1, so they activate after `owner`;
  // their handlers run in catalog order whatever the boot list order.
  const host = await boot([
    await core(),
    owner(),
    listener('zzz', (hooks) => hooks.onNoticeHook(record('zzz'))),
    listener('aaa', (hooks) => hooks.onNoticeHook(record('aaa'))),
  ]);

  try {
    await host.platform.services.use(OwnerRunV1).notice('hello');

    assert.deepEqual(seen, [
      { bundle: 'aaa', caller: 'owner' },
      { bundle: 'zzz', caller: 'owner' },
    ]);
  } finally {
    await host.close();
  }
});

void test('transform handlers chain; an invalid or failing handler keeps the previous value', async () => {
  const host = await boot([
    await core(),
    owner(),
    listener('a-double', (hooks) =>
      hooks.onShapeHook(({ value }) => ({ value: value * 2 })),
    ),
    listener('b-broken', (hooks) =>
      hooks.onShapeHook(() => ({ value: 'not a number' }) as never),
    ),
    listener('c-throws', (hooks) =>
      hooks.onShapeHook(() => {
        throw new Error('transform broke');
      }),
    ),
    listener('d-increment', (hooks) =>
      hooks.onShapeHook(({ value }) => ({ value: value + 1 })),
    ),
  ]);

  try {
    assert.deepEqual(await host.platform.services.use(OwnerRunV1).shape(5), {
      value: 11,
    });

    const errors = errorKinds(host.platform);

    assert.ok(errors.includes('b-broken:hook_handler_failed'));
    assert.ok(errors.includes('c-throws:hook_handler_failed'));
  } finally {
    await host.close();
  }
});

void test('decide stops at the first refusal; failures never count as refusals', async () => {
  const reached: string[] = [];
  const host = await boot([
    await core(),
    owner(),
    listener('a-throws', (hooks) =>
      hooks.onAllowHook(() => {
        reached.push('a-throws');
        throw new Error('decision broke');
      }),
    ),
    listener('b-allows', (hooks) =>
      hooks.onAllowHook(() => {
        reached.push('b-allows');
        return { allow: true };
      }),
    ),
    listener('c-refuses', (hooks) =>
      hooks.onAllowHook(() => {
        reached.push('c-refuses');
        return { allow: false, reason: 'not now' };
      }),
    ),
    listener('d-never', (hooks) =>
      hooks.onAllowHook(() => {
        reached.push('d-never');
        return { allow: true };
      }),
    ),
  ]);

  try {
    assert.deepEqual(await host.platform.services.use(OwnerRunV1).allow(), {
      allow: false,
      reason: 'not now',
    });
    assert.deepEqual(reached, ['a-throws', 'b-allows', 'c-refuses']);
  } finally {
    await host.close();
  }
});

void test('a handler that does not settle in time is reported and skipped', async () => {
  const seen: string[] = [];
  const host = await boot([
    await core({ hooks: { deadlineMs: 20 } }),
    owner(),
    listener('a-hangs', (hooks) =>
      hooks.onNoticeHook(() => new Promise(() => undefined)),
    ),
    listener('b-after', (hooks) =>
      hooks.onNoticeHook(() => {
        seen.push('b-after');
      }),
    ),
  ]);

  try {
    await host.platform.services.use(OwnerRunV1).notice('hello');

    assert.deepEqual(seen, ['b-after']);
    assert.ok(
      errorKinds(host.platform).includes('a-hangs:hook_handler_timeout'),
    );
  } finally {
    await host.close();
  }
});

void test('only the bundle that provides a hooks contract may define it', async () => {
  const failures: string[] = [];
  const host = await boot([
    await core(),
    owner(),
    probe('intruder', {
      requires: usesHooks,
      activate: ({ services }) => {
        for (const contract of [OwnerHooksV1, AppHooksV1]) {
          try {
            services.use(HooksV1).define(contract);
          } catch (error) {
            failures.push(isContractError(error) ? error.code : 'other');
          }
        }
      },
    }),
  ]);

  try {
    assert.deepEqual(failures, ['not_owner', 'not_owner']);
    assert.equal(states(host.platform).intruder, 'active');
  } finally {
    await host.close();
  }
});

void test("a handler registered later still runs in its bundle's catalog position", async () => {
  const seen: string[] = [];
  const LateV1 = ref<{ register(call?: CallArg): Promise<void> }>(
    'aaa.late/v1',
  );
  const host = await boot([
    await core(),
    owner(),
    listener('zzz', (hooks) =>
      hooks.onNoticeHook(() => {
        seen.push('zzz');
      }),
    ),
    probe('aaa', {
      requires: consumesOwnerHooks,
      provides: [['aaa.late/v1', 'service']],
      activate: ({ services }) => {
        services.provide(
          defineService('aaa.late/v1', {
            register: defineMethod({
              input: z.tuple([]),
              output: z.void(),
              execute: async () => {
                registrar(services).onNoticeHook(() => {
                  seen.push('aaa');
                });
              },
            }),
          }),
        );
      },
    }),
  ]);

  try {
    await host.platform.services.use(LateV1).register();
    await host.platform.services.use(OwnerRunV1).notice('ordered');

    assert.deepEqual(seen, ['aaa', 'zzz']);
  } finally {
    await host.close();
  }
});

void test('defining twice returns the same handle to the same owner', async () => {
  const handles: unknown[] = [];
  const host = await boot([
    await core(),
    probe('owner', {
      requires: usesHooks,
      provides: [['owner.hooks/v1', 'hooks']],
      activate: ({ services }) => {
        handles.push(services.use(HooksV1).define(OwnerHooksV1));
        handles.push(services.use(HooksV1).define(OwnerHooksV1));
      },
    }),
  ]);

  try {
    assert.equal(handles.length, 2);
    assert.equal(handles[0], handles[1]);
    assert.equal(states(host.platform).owner, 'active');
  } finally {
    await host.close();
  }
});

void test('whenAvailable registers once the owner defines its hooks', async () => {
  const seen: string[] = [];
  const host = await boot([
    await core(),
    owner(),
    // `aaa` subscribes before `owner` activates and defines the contract.
    probe('aaa', {
      requires: usesHooks,
      activate: ({ services }) => {
        services.use(HooksV1).whenAvailable(OwnerHooksV1, (hooks) => {
          hooks.onNoticeHook(({ text }) => {
            seen.push(text);
          });
        });
      },
    }),
  ]);

  try {
    await host.platform.services.use(OwnerRunV1).notice('defined later');

    assert.deepEqual(seen, ['defined later']);
  } finally {
    await host.close();
  }
});

void test('an input the hook schema rejects fails the owner, not a handler', async () => {
  const host = await boot([
    await core(),
    probe('owner', {
      requires: usesHooks,
      provides: [
        ['owner.hooks/v1', 'hooks'],
        ['owner.run/v1', 'service'],
      ],
      activate: ({ services }) => {
        const handle = services.use(HooksV1).define(OwnerHooksV1);

        services.provide(
          defineService('owner.run/v1', {
            notice: defineMethod({
              input: z.string(),
              output: z.void(),
              execute: async () => {
                await handle.onNoticeHook.execute({ text: 42 } as never);
              },
            }),
          }),
        );
      },
    }),
  ]);

  try {
    await assert.rejects(
      host.platform.services.use(OwnerRunV1).notice('x'),
      (error: unknown) =>
        isContractError(error) && error.code === 'invalid_input',
    );
    assert.deepEqual(reasonCodes(host.platform, 'owner'), []);
  } finally {
    await host.close();
  }
});

/** A sequence step (awaited, no deadline) and a reverse sequence of `owner`. */
const SequenceHooksV1 = defineHooks('owner.sequence/v1', {
  onStepHook: defineHook({
    kind: 'sequence',
    input: z.object({ label: z.string() }).strict(),
  }),
  onUnwindHook: defineHook({
    kind: 'sequence',
    order: 'reverse',
    input: z.object({}).strict(),
  }),
});

const SequenceRunV1 = ref<{
  step(label: string, call?: CallArg): Promise<void>;
  unwind(call?: CallArg): Promise<void>;
}>('owner.run2/v1');

const sequenceOwner = () => {
  let handle: HookHandle<typeof SequenceHooksV1> | undefined;

  return probe('owner-sequence', {
    requires: usesHooks,
    provides: [
      ['owner.sequence/v1', 'hooks'],
      ['owner.run2/v1', 'service'],
    ],
    activate: ({ services }) => {
      handle = services.use(HooksV1).define(SequenceHooksV1);
      services.provide(
        defineService('owner.run2/v1', {
          step: defineMethod({
            input: z.string(),
            output: z.void(),
            execute: async (label) => {
              await handle?.onStepHook.execute({ label });
            },
          }),
          unwind: defineMethod({
            input: z.tuple([]),
            output: z.void(),
            execute: async () => {
              await handle?.onUnwindHook.execute({});
            },
          }),
        }),
      );
    },
  });
};

const sequenceListener = (
  id: string,
  register: (hooks: ReturnType<typeof sequenceRegistrar>) => void,
) =>
  probe(id, {
    requires: [...usesHooks, 'owner.sequence/v1@^1.0.0'],
    activate: ({ services }) => register(sequenceRegistrar(services)),
  });

const sequenceRegistrar = (services: Services) =>
  services.use(HooksV1).use(SequenceHooksV1);

void test('sequence handlers run one at a time, in catalog order, each awaited', async () => {
  const seen: string[] = [];
  const host = await boot([
    await core(),
    sequenceOwner(),
    sequenceListener('zzz', (hooks) =>
      hooks.onStepHook(() => {
        seen.push('zzz');
      }),
    ),
    sequenceListener('aaa', (hooks) =>
      hooks.onStepHook(async () => {
        seen.push('aaa-start');
        await new Promise((done) => setTimeout(done, 10));
        seen.push('aaa-end');
      }),
    ),
  ]);

  try {
    await host.platform.services.use(SequenceRunV1).step('go');

    assert.deepEqual(seen, ['aaa-start', 'aaa-end', 'zzz']);
  } finally {
    await host.close();
  }
});

void test('a failing sequence handler rejects the execution, and the later handlers do not run', async () => {
  const seen: string[] = [];
  const host = await boot([
    await core(),
    sequenceOwner(),
    sequenceListener('aaa', (hooks) =>
      hooks.onStepHook(() => {
        throw new Error('the step broke');
      }),
    ),
    sequenceListener('zzz', (hooks) =>
      hooks.onStepHook(() => {
        seen.push('zzz');
      }),
    ),
  ]);

  try {
    await assert.rejects(
      host.platform.services.use(SequenceRunV1).step('go'),
      /the step broke/,
    );
    assert.deepEqual(seen, []);
    // A sequence failure is the owner's to handle, not a diagnostic.
    assert.equal(
      errorKinds(host.platform).includes('aaa:hook_handler_failed'),
      false,
    );
  } finally {
    await host.close();
  }
});

void test('a sequence handler has no deadline: the observe deadline does not cut it off', async () => {
  const seen: string[] = [];
  const host = await boot([
    await core({ hooks: { deadlineMs: 20 } }),
    sequenceOwner(),
    sequenceListener('slow', (hooks) =>
      hooks.onStepHook(async () => {
        await new Promise((done) => setTimeout(done, 80));
        seen.push('slow');
      }),
    ),
  ]);

  try {
    await host.platform.services.use(SequenceRunV1).step('go');

    assert.deepEqual(seen, ['slow']);
    assert.equal(
      errorKinds(host.platform).some((kind) =>
        kind.endsWith('hook_handler_timeout'),
      ),
      false,
    );
  } finally {
    await host.close();
  }
});

void test('a reverse sequence runs in reverse catalog order', async () => {
  const seen: string[] = [];
  const host = await boot([
    await core(),
    sequenceOwner(),
    sequenceListener('aaa', (hooks) =>
      hooks.onUnwindHook(() => {
        seen.push('aaa');
      }),
    ),
    sequenceListener('zzz', (hooks) =>
      hooks.onUnwindHook(() => {
        seen.push('zzz');
      }),
    ),
  ]);

  try {
    await host.platform.services.use(SequenceRunV1).unwind();

    assert.deepEqual(seen, ['zzz', 'aaa']);
  } finally {
    await host.close();
  }
});
