// `chat`'s host part (phase 3, S58): `chat.composer/v1` over the shared
// composer state, in memory, and the `message` kind's
// `ComposerFlushHandlerService`.

import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
import {
  type BundleInstance,
  type HostContext,
  stampedCallerOf,
} from 'bundle/host';

import {
  ComposerFlushHandlerService,
  type ComposerService,
} from '../contracts/gen/doric/chat/composer/v1/composer_pb.js';
import { createComposerState } from '../shared/composer-state.js';
import { MESSAGE_KIND, messageFlush } from '../shared/message-flush.js';
import {
  addInputOf,
  commentWriteMessageOf,
  flushContextOf,
  flushedMessageOf,
  itemMessageOf,
  itemOf,
  snapshotMessageOf,
  watchResponseOf,
  wireFlush,
} from './codec.js';
import { type ComposerFlushes, createComposerFlushes } from './flushes.js';
import { streamOf } from './stream.js';

export interface ChatHost {
  /**
   * `chat.composer/v1` over one `createComposerState(new Map(), { flushOf: flushes.flushOf })`, the key's Project
   * being `callOf(context).scope?.projectId` (absent → `undefined`):
   * - `Read{threadId}` → `{composerSnapshot: snapshotMessageOf(state.read(…))}`;
   * - `Watch{threadId}` → `streamOf(sink => state.watch(…, (item, revision) => sink.next(watchResponseOf(item,
   *   revision))), context.signal)`: the snapshot first, then every change with its revision; ends only when the
   *   caller cancels or the instance stops;
   * - `SetText`, `UpdateNote`, `RemoveItem` → the state's method, `{}`;
   * - `AddItem` → `{composerItem: itemMessageOf(state.addItem(…, addInputOf(request)))}`;
   * - `Flush{threadId, promptId}` → `state.flush({projectId, threadId, promptId})`, answered
   *   `{flushed: flushed.map(flushedMessageOf)}`; rejects as the state does (a handler's error unchanged);
   * - `RegisterFlush{kind}` → `flushes.register(stampedCallerOf(context), kind)`;
   * - `Unregister{registrationId}` → `flushes.unregister(stampedCallerOf(context), id)`, `{}`.
   * Requests are validated with protovalidate before (`invalid_input`). Every method answers `ContractError
   * ('unavailable', 'chat is not active.')` before `activate` ran.
   */
  readonly composer: ServiceImpl<typeof ComposerService>;
  /**
   * `ComposerFlushHandlerService` for the kind `message`: `Flush{item, context}` → `{writes:
   * (await wireFlush(messageFlush)(itemOf(item), flushContextOf(context))).map(commentWriteMessageOf)}` — the same
   * function `Flush` runs in process. An item of another kind is `invalid_input` "chat flushes only the message
   * kind."; `unavailable` before `activate`.
   */
  readonly flushHandler: ServiceImpl<typeof ComposerFlushHandlerService>;
  /**
   * Synchronous, no router call: `createComposerFlushes({ self: context.instance, local: { message: wireFlush
   * (messageFlush) }, handlerOf: caller => context.services.use(ComposerFlushHandlerService, { target }) })`, then
   * `context.instances.onGone(instanceGone)`; the services answer from here on.
   */
  activate(
    context: Pick<HostContext, 'instance' | 'services' | 'instances'>,
  ): void;
  /** Removes the `onGone` handler. Open watches end with their calls when the instance stops. */
  deactivate(): void;
  /** What `activate` hands to `onGone`: `flushes.dropInstance(instance)`; a no-op before `activate`. Tests call it. */
  instanceGone(instance: BundleInstance): void;
}

/** Builds the part with no I/O; the state is empty; never throws. */
export const createChatHost = (): ChatHost => {
  const message = wireFlush(messageFlush);
  let active:
    | { readonly flushes: ComposerFlushes; readonly stopGone: () => void }
    | undefined;
  const state = createComposerState(new Map(), {
    flushOf: (kind) => active?.flushes.flushOf(kind),
  });

  const activated = () => {
    if (active === undefined) {
      throw new ContractError('unavailable', 'chat is not active.');
    }

    return active;
  };

  const projectOf = (context: HandlerContext): string | undefined =>
    callOf(context).scope?.projectId;

  const instanceGone = (instance: BundleInstance): void => {
    active?.flushes.dropInstance(instance);
  };

  return {
    composer: {
      read: (request, context) => {
        activated();

        return {
          composerSnapshot: snapshotMessageOf(
            state.read(projectOf(context), request.threadId),
          ),
        };
      },
      watch: async function* (request, context) {
        activated();

        yield* streamOf(
          (sink) =>
            state.watch(
              projectOf(context),
              request.threadId,
              (item, revision) => sink.next(watchResponseOf(item, revision)),
            ),
          callOf(context).signal,
        );
      },
      setText: (request, context) => {
        activated();
        state.setText(projectOf(context), request.threadId, request.text);

        return {};
      },
      addItem: (request, context) => {
        activated();

        return {
          composerItem: itemMessageOf(
            state.addItem(projectOf(context), addInputOf(request)),
          ),
        };
      },
      updateNote: (request, context) => {
        activated();
        state.updateNote(
          projectOf(context),
          request.threadId,
          request.id,
          request.note,
        );

        return {};
      },
      removeItem: (request, context) => {
        activated();
        state.removeItem(projectOf(context), request.threadId, request.id);

        return {};
      },
      flush: async (request, context) => {
        activated();
        const projectId = projectOf(context);
        const flushed = await state.flush({
          ...(projectId === undefined ? {} : { projectId }),
          threadId: request.threadId,
          promptId: request.promptId,
        });

        return { flushed: flushed.map(flushedMessageOf) };
      },
      registerFlush: (request, context) =>
        activated().flushes.register(stampedCallerOf(context), request.kind),
      unregister: (request, context) => {
        activated().flushes.unregister(
          stampedCallerOf(context),
          request.registrationId,
        );

        return {};
      },
    },
    flushHandler: {
      flush: async (request) => {
        activated();
        const { item, context } = request;

        if (item === undefined || context === undefined) {
          throw new ContractError(
            'invalid_input',
            'A flush needs an item and its context.',
          );
        }

        if (item.kind !== MESSAGE_KIND) {
          throw new ContractError(
            'invalid_input',
            'chat flushes only the message kind.',
          );
        }

        const writes = await message(itemOf(item), flushContextOf(context));

        return {
          writes: writes.flatMap((write) => commentWriteMessageOf(write) ?? []),
        };
      },
    },
    activate: (context) => {
      const flushes = createComposerFlushes({
        self: context.instance,
        local: new Map([[MESSAGE_KIND, message]]),
        handlerOf: (caller) =>
          context.services.use(ComposerFlushHandlerService, {
            target: `${caller.bundleId}/${caller.generation}/${caller.incarnation}`,
          }),
      });

      active = {
        flushes,
        stopGone: context.instances.onGone(instanceGone),
      };
    },
    deactivate: () => {
      active?.stopGone();
    },
    instanceGone,
  };
};
