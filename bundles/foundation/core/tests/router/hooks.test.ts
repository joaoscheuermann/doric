// `hooks/v1` served by `core` over the router (S40b): hooks contracts
// defined by their providers from the `.proto` options in `types`, handlers
// registered by any instance under D4's key rule, and `Run` relayed to each
// handler instance's `HookHandlerService` with today's semantics per kind.
// Also `core.event-hooks/v1`, which `core` defines at `activate` and runs
// after each committed `events/v1.Append`. A registering "instance" is a
// router client caller (incarnation 1); its handler service is the
// per-target fake of `serveCore` (`handlers`, `handlerCalls`), and the
// diagnostics it causes land in the `doric.diagnostics/v1` fake (`reports`).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  create,
  type DescMessage,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import {
  type Any,
  anyPack,
  anyUnpack,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError } from '@connectrpc/connect';
import {
  type CallScope,
  ContractError,
  fromConnectError,
} from 'bundle/contracts';
import { EventsService } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import {
  type HookHandlerServiceHandleRequest,
  type HookHandlerServiceHandleResponseSchema,
  HooksService,
} from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';

import { OnEventAppendedHookInputSchema } from '../../src/contracts/gen/doric/core/event_hooks/v1/event_hooks_pb.js';
import {
  type RoutedCore,
  type ServeCoreOptions,
  serveCore,
  testMessages,
} from '../support/router.js';

const types = testMessages();

const messageOf = (typeName: string): DescMessage => {
  const desc = types.getMessage(typeName);

  assert.ok(desc !== undefined, typeName);

  return desc;
};

const SeenInput = messageOf('notes.hooks.SeenInput');
const ShapeInput = messageOf('notes.hooks.ShapeInput');
const AllowInput = messageOf('notes.hooks.AllowInput');
const StepInput = messageOf('notes.hooks.StepInput');
const UnwindInput = messageOf('notes.hooks.UnwindInput');
const Added = messageOf('notes.Added');

const pack = (desc: DescMessage, text: string): Any =>
  anyPack(desc, create(desc, { text } as MessageInitShape<typeof desc>));

/** The `text` an `Any` of a `notes.hooks` input carries. */
const textOf = (value: Any | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const message = anyUnpack(value, types) as { text?: string } | undefined;

  return message?.text;
};

const NOTES_HOOKS = 'notes.hooks/v1';
const PROVIDES_HOOKS = `${NOTES_HOOKS}@1.0.0`;

/**
 * The catalog of every test: `notes` and `alt` provide `notes.hooks/v1`,
 * `notes` also `notes.ghost/v1` (which no file defines) and the events of
 * the event-hooks test. The catalog order is `core`, then the bundles in
 * this order.
 */
const served = (options: ServeCoreOptions = {}): Promise<RoutedCore> =>
  serveCore({
    bundles: {
      notes: [
        PROVIDES_HOOKS,
        'notes.ghost/v1@1.0.0',
        'notes.added/v1@1.0.0',
      ],
      a: [],
      b: [],
      c: [],
      other: [],
      alt: [PROVIDES_HOOKS],
      runtime: [],
    },
    ...options,
  });

const withCore = async (
  run: (core: RoutedCore) => Promise<void>,
  options: ServeCoreOptions = {},
) => {
  const core = await served(options);

  try {
    await run(core);
  } finally {
    await core.close();
  }
};

const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectError, `not a ConnectError: ${error}`);
    assert.equal(fromConnectError(error).code, code, error.message);

    return true;
  });
};

const hooks = (
  core: RoutedCore,
  bundleId: string,
  generation?: number,
): Client<typeof HooksService> =>
  core.client(
    HooksService,
    bundleId,
    generation === undefined ? {} : { generation },
  );

type HandleAnswer = MessageInitShape<
  typeof HookHandlerServiceHandleResponseSchema
>;

type Handle = (
  request: HookHandlerServiceHandleRequest,
  context: { readonly signal: AbortSignal },
) => HandleAnswer | Promise<HandleAnswer>;

/** Serves `handle` as the `HookHandlerService` of `target`. */
const serveHandler = (core: RoutedCore, target: string, handle: Handle) => {
  core.handlers.set(target, { hooks: { handle: handle as never } });
};

/** The targets of the `HookHandlerService.Handle` calls core made, in order. */
const handled = (core: RoutedCore): string[] =>
  core.handlerCalls
    .filter(({ method }) => method === 'handle')
    .map(({ target }) => target);

/** What each report tells: the bundle, the kind and the details. */
const reported = (core: RoutedCore) =>
  core.reports.map((report) => ({
    bundleId: report.bundleId,
    kind: report.kind,
    details:
      report.details === undefined
        ? undefined
        : toJson(ValueSchema, report.details),
  }));

/** `notes` defines `notes.hooks/v1`; answers the definition id. */
const defined = async (core: RoutedCore): Promise<string> => {
  const { registrationId } = await hooks(core, 'notes').define({
    contract: NOTES_HOOKS,
  });

  assert.notEqual(registrationId, '');

  return registrationId;
};

/** `bundleId` registers a handler of `hook`; answers the registration id. */
const registered = async (
  core: RoutedCore,
  bundleId: string,
  hook: string,
  options: { readonly order?: number; readonly generation?: number } = {},
): Promise<string> => {
  const { registrationId } = await hooks(
    core,
    bundleId,
    options.generation,
  ).register({
    contract: NOTES_HOOKS,
    hook,
    ...(options.order === undefined ? {} : { order: options.order }),
  });

  assert.notEqual(registrationId, '');

  return registrationId;
};

/** `notes` (the definer) runs `hook` of `notes.hooks/v1`. */
const run = (core: RoutedCore, hook: string, input: Any) =>
  hooks(core, 'notes').run({ contract: NOTES_HOOKS, hook, input });

/** Waits until `ready` holds or 2 s passed, polling every millisecond. */
const until = async (ready: () => boolean) => {
  const deadline = Date.now() + 2000;

  while (!ready() && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 1));
  }
};

const sleep = (ms: number) =>
  new Promise((done) => setTimeout(done, ms));

/** The next item of `items`, failing the test after 2 s. */
const nextOf = async <T>(items: AsyncIterator<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('no item within 2 s')),
      2000,
    );
  });

  try {
    const item = await Promise.race([items.next(), timeout]);

    assert.equal(item.done, false, 'the stream ended');

    return item.value as T;
  } finally {
    clearTimeout(timer);
  }
};

void test('Define: the provider defines and gets the same id again; others are not_owner, an unknown contract is invalid_input, a second provider is registration_conflict', async () => {
  await withCore(async (core) => {
    const first = await defined(core);

    assert.equal(await defined(core), first);

    await rejectsWith(
      hooks(core, 'other').define({ contract: NOTES_HOOKS }),
      'not_owner',
    );
    await rejectsWith(
      hooks(core, 'notes').define({ contract: 'doric.window.hooks/v1' }),
      'not_owner',
    );
    await rejectsWith(
      hooks(core, 'notes').define({ contract: 'notes.ghost/v1' }),
      'invalid_input',
    );
    await rejectsWith(
      hooks(core, 'alt').define({ contract: NOTES_HOOKS }),
      'registration_conflict',
    );
  });
});

void test('WatchAvailability yields the present state, then each change of a served definition, through Unregister and InstanceGone', async () => {
  await withCore(async (core) => {
    const stop = new AbortController();
    const watched = hooks(core, 'a')
      .watchAvailability({ contract: NOTES_HOOKS }, { signal: stop.signal })
      [Symbol.asyncIterator]();

    try {
      assert.equal((await nextOf(watched)).available, false);

      const definition = await defined(core);

      assert.equal((await nextOf(watched)).available, true);

      await hooks(core, 'notes').unregister({ registrationId: definition });
      assert.equal((await nextOf(watched)).available, false);

      await defined(core);
      assert.equal((await nextOf(watched)).available, true);

      core.instanceGone({ bundleId: 'notes', generation: 1 });
      assert.equal((await nextOf(watched)).available, false);
    } finally {
      stop.abort();
      await watched.return?.().catch(() => undefined);
    }
  });
});

void test('observe: ordered handlers first, then catalog order; a failing handler is reported as hook_handler_failed and the run goes on', async () => {
  await withCore(async (core) => {
    const seen: { target: string; text: string | undefined }[] = [];

    for (const target of ['a/1/1', 'b/1/1', 'c/1/1']) {
      serveHandler(core, target, (request) => {
        seen.push({ target, text: textOf(request.input) });

        if (target === 'a/1/1') {
          throw new ContractError('invalid_input', 'a refuses');
        }

        return {};
      });
    }

    await defined(core);
    await registered(core, 'a', 'onSeenHook');
    await registered(core, 'b', 'onSeenHook');
    await registered(core, 'c', 'onSeenHook', { order: 1 });

    const answer = await run(core, 'onSeenHook', pack(SeenInput, 'hello'));

    assert.equal(answer.output, undefined);
    assert.equal(answer.decision, undefined);
    assert.deepEqual(seen, [
      { target: 'c/1/1', text: 'hello' },
      { target: 'a/1/1', text: 'hello' },
      { target: 'b/1/1', text: 'hello' },
    ]);
    assert.deepEqual(
      core.handlerCalls.map(({ request }) => {
        const { contract, hook } = request as HookHandlerServiceHandleRequest;

        return { contract, hook };
      }),
      Array.from({ length: 3 }, () => ({
        contract: NOTES_HOOKS,
        hook: 'onSeenHook',
      })),
    );
    assert.deepEqual(reported(core), [
      {
        bundleId: 'a',
        kind: 'hook_handler_failed',
        details: { contract: NOTES_HOOKS, hook: 'onSeenHook' },
      },
    ]);
  });
});

void test('transform chains output; a missing output or one of another type is reported and the previous value kept; with no handler the output is the input', async () => {
  await withCore(async (core) => {
    await defined(core);

    const unhandled = await run(core, 'onShapeHook', pack(ShapeInput, 'start'));

    assert.equal(textOf(unhandled.output), 'start');

    const received: Record<string, string | undefined> = {};
    const answers: Record<string, (text: string) => HandleAnswer> = {
      a: (text) => ({ output: pack(ShapeInput, `${text}-a`) }),
      b: () => ({}),
      c: (text) => ({ output: pack(SeenInput, `${text}-c`) }),
      other: (text) => ({ output: pack(ShapeInput, `${text}-o`) }),
    };

    for (const [bundleId, answer] of Object.entries(answers)) {
      serveHandler(core, `${bundleId}/1/1`, (request) => {
        const text = textOf(request.input) ?? '';

        received[bundleId] = text;

        return answer(text);
      });
      await registered(core, bundleId, 'onShapeHook');
    }

    const answer = await run(core, 'onShapeHook', pack(ShapeInput, 'start'));

    assert.equal(answer.output?.typeUrl, pack(ShapeInput, '').typeUrl);
    assert.equal(textOf(answer.output), 'start-a-o');
    assert.deepEqual(received, {
      a: 'start',
      b: 'start-a',
      c: 'start-a',
      other: 'start-a',
    });
    assert.deepEqual(
      reported(core).map(({ bundleId, kind }) => ({ bundleId, kind })),
      [
        { bundleId: 'b', kind: 'hook_handler_failed' },
        { bundleId: 'c', kind: 'hook_handler_failed' },
      ],
    );
  });
});

void test('decide answers the first refusal and calls no later handler; a failure or a missing decision is reported and is not a refusal', async () => {
  await withCore(async (core) => {
    serveHandler(core, 'a/1/1', () => ({}));
    serveHandler(core, 'b/1/1', () => {
      throw new ContractError('unavailable', 'b is down');
    });
    serveHandler(core, 'c/1/1', () => ({
      decision: { allow: false, reason: 'c says no' },
    }));
    serveHandler(core, 'other/1/1', () => ({ decision: { allow: true } }));

    await defined(core);

    for (const bundleId of ['a', 'b', 'c', 'other']) {
      await registered(core, bundleId, 'onAllowHook');
    }

    const refused = await run(core, 'onAllowHook', pack(AllowInput, 'x'));

    assert.equal(refused.decision?.allow, false);
    assert.equal(refused.decision?.reason, 'c says no');
    assert.deepEqual(handled(core), ['a/1/1', 'b/1/1', 'c/1/1']);
    assert.deepEqual(
      reported(core).map(({ bundleId, kind }) => ({ bundleId, kind })),
      [
        { bundleId: 'a', kind: 'hook_handler_failed' },
        { bundleId: 'b', kind: 'hook_handler_failed' },
      ],
    );
  });

  await withCore(async (core) => {
    for (const bundleId of ['a', 'b']) {
      serveHandler(core, `${bundleId}/1/1`, () => ({
        decision: { allow: true },
      }));
    }

    await defined(core);
    await registered(core, 'a', 'onAllowHook');
    await registered(core, 'b', 'onAllowHook');

    const allowed = await run(core, 'onAllowHook', pack(AllowInput, 'x'));

    assert.equal(allowed.decision?.allow, true);
    assert.equal(allowed.decision?.reason, undefined);
    assert.deepEqual(handled(core), ['a/1/1', 'b/1/1']);
  });
});

void test('a handler past the hook deadline is reported as hook_handler_timeout and the next handler runs', async () => {
  await withCore(
    async (core) => {
      serveHandler(
        core,
        'a/1/1',
        (_, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      );
      serveHandler(core, 'b/1/1', () => ({}));

      await defined(core);
      await registered(core, 'a', 'onSeenHook');
      await registered(core, 'b', 'onSeenHook');

      await run(core, 'onSeenHook', pack(SeenInput, 'slow'));

      assert.deepEqual(handled(core), ['a/1/1', 'b/1/1']);
      assert.deepEqual(reported(core), [
        {
          bundleId: 'a',
          kind: 'hook_handler_timeout',
          details: { contract: NOTES_HOOKS, hook: 'onSeenHook' },
        },
      ]);
    },
    { hookDeadlineMs: 50 },
  );
});

void test('sequence awaits each handler in order with no hook deadline', async () => {
  await withCore(
    async (core) => {
      const steps: string[] = [];

      serveHandler(core, 'a/1/1', async () => {
        steps.push('a started');
        await sleep(100);
        steps.push('a done');

        return {};
      });
      serveHandler(core, 'b/1/1', () => {
        steps.push('b started');

        return {};
      });

      await defined(core);
      await registered(core, 'a', 'onStepHook');
      await registered(core, 'b', 'onStepHook');

      const answer = await run(core, 'onStepHook', pack(StepInput, 'go'));

      assert.equal(answer.output, undefined);
      assert.deepEqual(steps, ['a started', 'a done', 'b started']);
      assert.deepEqual(core.reports, []);
    },
    { hookDeadlineMs: 50 },
  );
});

void test('sequence: the first failing handler fails Run with its code and no later handler runs', async () => {
  await withCore(async (core) => {
    serveHandler(core, 'a/1/1', () => {
      throw new ContractError('limit_exceeded', 'a is full');
    });
    serveHandler(core, 'b/1/1', () => ({}));

    await defined(core);
    await registered(core, 'a', 'onStepHook');
    await registered(core, 'b', 'onStepHook');

    await rejectsWith(
      run(core, 'onStepHook', pack(StepInput, 'go')),
      'limit_exceeded',
    );
    assert.deepEqual(handled(core), ['a/1/1']);
  });
});

void test('sequence with HOOK_ORDER_REVERSE calls the handlers in reverse catalog order', async () => {
  await withCore(async (core) => {
    serveHandler(core, 'a/1/1', () => ({}));
    serveHandler(core, 'b/1/1', () => ({}));

    await defined(core);
    await registered(core, 'a', 'onUnwindHook');
    await registered(core, 'b', 'onUnwindHook');

    await run(core, 'onUnwindHook', pack(UnwindInput, 'back'));

    assert.deepEqual(handled(core), ['b/1/1', 'a/1/1']);
  });
});

void test('Run errors: a caller not serving the definition is not_owner; an unknown hook or an input of another type is invalid_input, with no handler call', async () => {
  await withCore(async (core) => {
    serveHandler(core, 'a/1/1', () => ({ output: pack(ShapeInput, 'x') }));

    await defined(core);
    await registered(core, 'a', 'onShapeHook');

    await rejectsWith(
      hooks(core, 'other').run({
        contract: NOTES_HOOKS,
        hook: 'onShapeHook',
        input: pack(ShapeInput, 'x'),
      }),
      'not_owner',
    );
    await rejectsWith(
      run(core, 'onNothingHook', pack(ShapeInput, 'x')),
      'invalid_input',
    );
    await rejectsWith(
      run(core, 'onShapeHook', pack(SeenInput, 'x')),
      'invalid_input',
    );
    assert.deepEqual(handled(core), []);
  });
});

void test('handler registrations follow D4: the same instance keeps its id with the new order, a newer instance serves, InstanceGone and Unregister end it', async () => {
  await withCore(async (core) => {
    for (const target of ['a/1/1', 'a/2/1', 'b/1/1']) {
      serveHandler(core, target, () => ({}));
    }

    await defined(core);

    /** The targets one `Run` of `onSeenHook` calls, in order. */
    const runSeen = async () => {
      const before = handled(core).length;

      await run(core, 'onSeenHook', pack(SeenInput, 'x'));

      return handled(core).slice(before);
    };
    const first = await registered(core, 'a', 'onSeenHook');
    const bFirst = await registered(core, 'b', 'onSeenHook');

    assert.deepEqual(await runSeen(), ['a/1/1', 'b/1/1']);

    assert.equal(
      await registered(core, 'b', 'onSeenHook', { order: 1 }),
      bFirst,
    );
    assert.deepEqual(await runSeen(), ['b/1/1', 'a/1/1']);

    await registered(core, 'a', 'onSeenHook', { generation: 2 });
    assert.deepEqual(await runSeen(), ['b/1/1', 'a/2/1']);

    core.instanceGone({ bundleId: 'a', generation: 2 });
    assert.deepEqual(await runSeen(), ['b/1/1', 'a/1/1']);

    await hooks(core, 'a').unregister({ registrationId: first });
    assert.deepEqual(await runSeen(), ['b/1/1']);
  });
});

void test('core.event-hooks/v1 is available after activate, and each committed append runs onEventAppendedHook at the registered instance without awaiting it', async () => {
  await withCore(async (core) => {
    const stop = new AbortController();
    const watched = hooks(core, 'runtime')
      .watchAvailability(
        { contract: 'core.event-hooks/v1' },
        { signal: stop.signal },
      )
      [Symbol.asyncIterator]();

    try {
      assert.equal((await nextOf(watched)).available, true);
    } finally {
      stop.abort();
      await watched.return?.().catch(() => undefined);
    }

    serveHandler(core, 'runtime/1/1', () => {
      throw new ContractError('unavailable', 'the observer is down');
    });
    await hooks(core, 'runtime').register({
      contract: 'core.event-hooks/v1',
      hook: 'onEventAppendedHook',
    });

    const scope: CallScope = { projectId: 'p-1', threadId: 't-1' };
    const notes = core.client(EventsService, 'notes', { scope });

    await notes.register({ type: 'notes.added/v1', messageType: 'notes.Added' });
    await notes.sink({
      scopeKeys: ['projectId', 'threadId'],
      stream: 'notes.thread-events/{threadId}',
    });

    await rejectsWith(
      notes.append({
        type: 'notes.added/v1',
        payload: anyPack(Added, create(Added, { noteId: '' } as never)),
      }),
      'invalid_input',
    );
    // A throwing handler does not fail the append.
    await notes.append({
      type: 'notes.added/v1',
      payload: anyPack(Added, create(Added, { noteId: 'n-1' } as never)),
    });

    await until(() => handled(core).length > 0);
    await sleep(20);

    assert.deepEqual(handled(core), ['runtime/1/1']);

    const request = core.handlerCalls[0]?.request as
      | HookHandlerServiceHandleRequest
      | undefined;

    assert.equal(request?.contract, 'core.event-hooks/v1');
    assert.equal(request?.hook, 'onEventAppendedHook');
    assert.ok(request?.input !== undefined);

    const input = anyUnpack(request.input, OnEventAppendedHookInputSchema);

    assert.deepEqual(
      { stream: input?.stream, type: input?.type },
      { stream: 'notes.thread-events/t-1', type: 'notes.added/v1' },
    );
  });
});
