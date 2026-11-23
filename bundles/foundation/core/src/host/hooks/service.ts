// The core's `hooks/v1` over the router: hooks contracts defined by their
// providers, handlers registered by any instance, and `Run` relayed to each
// handler instance's `HookHandlerService` with today's semantics per kind.

import {
  create,
  type DescMessage,
  getOption,
  hasOption,
  type MessageInitShape,
  type Registry,
} from '@bufbuild/protobuf';
import { type Any, anyIs } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import {
  type Call,
  ContractError,
  callOf,
  fromConnectError,
} from 'bundle/contracts';
import {
  HookHandlerService,
  type HooksService,
  type RunResponse,
  RunResponseSchema,
} from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import {
  HookKind,
  HookOrder,
  hook as hookOption,
  hooks as hooksOption,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import {
  type BundleInstance,
  type RegistrationEntry,
  RegistrationTable,
  type StampedCaller,
  stampedCallerOf,
} from 'bundle/host';

import { file_doric_core_event_hooks_v1_event_hooks } from '../../contracts/gen/doric/core/event_hooks/v1/event_hooks_pb.js';
import type { CoreBinding } from '../binding.js';
import { createInbox } from '../inbox.js';
import type { InstanceRegistrations } from '../tools/service.js';

/** The default of `CoreServicesOptions.hookDeadlineMs`, in ms. */
export const DEFAULT_HOOK_DEADLINE_MS = 10_000;

/** `core`'s own hooks contract, defined by `activate`. */
export const CORE_EVENT_HOOKS = 'core.event-hooks/v1';

/** One hook of a hooks contract, read from its input message's options. */
export interface HookShape {
  readonly name: string;
  readonly kind: 'observe' | 'transform' | 'decide' | 'sequence';
  /** `HOOK_ORDER_REVERSE` → 'reverse'; otherwise 'activation'. */
  readonly order: 'activation' | 'reverse';
  /** The input message's full name; the `Any` a run carries must name it. */
  readonly typeName: string;
}

/**
 * The hooks of the hooks contract `contract`, by name: every message in
 * `types` (or in `core.event-hooks/v1`'s file) whose file's
 * `(doric.platform.v1.hooks).id` is `contract` and that has
 * `(doric.platform.v1.hook)`. Answers `undefined` when no file defines the
 * contract. Pure.
 */
export const hooksOf = (
  types: Registry,
  contract: string,
): ReadonlyMap<string, HookShape> | undefined => {
  const messages: DescMessage[] = [
    ...file_doric_core_event_hooks_v1_event_hooks.messages,
  ];

  for (const desc of types) {
    if (desc.kind === 'message') {
      messages.push(desc);
    }
  }

  let defined = false;
  const shapes = new Map<string, HookShape>();

  for (const desc of messages) {
    if (
      !hasOption(desc.file, hooksOption) ||
      getOption(desc.file, hooksOption).id !== contract
    ) {
      continue;
    }

    defined = true;

    if (!hasOption(desc, hookOption)) {
      continue;
    }

    const option = getOption(desc, hookOption);
    const kind = kinds.get(option.kind);

    if (kind !== undefined) {
      shapes.set(option.name, {
        name: option.name,
        kind,
        order: option.order === HookOrder.REVERSE ? 'reverse' : 'activation',
        typeName: desc.typeName,
      });
    }
  }

  return defined ? shapes : undefined;
};

const kinds = new Map<HookKind, HookShape['kind']>([
  [HookKind.OBSERVE, 'observe'],
  [HookKind.TRANSFORM, 'transform'],
  [HookKind.DECIDE, 'decide'],
  [HookKind.SEQUENCE, 'sequence'],
]);

/** A hooks contract's definition, or one bundle's handler of one hook. */
type HookRegistration =
  | { readonly kind: 'definition'; readonly contract: string }
  | {
      readonly kind: 'handler';
      readonly contract: string;
      readonly hook: string;
      readonly order: number | undefined;
    };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `hooks/v1` as `createCoreServices` serves it. Definitions and handlers sit
 * in one `RegistrationTable<…>({ conflictCode: 'registration_conflict' })`:
 * a definition is keyed by its contract, and a handler by `(contract, hook,
 * bundleId)`. So the bundles never conflict over a handler, and each
 * bundle's newest instance serves.
 *
 * - `Define`:
 *   - A `doric.*` contract is refused with `not_owner` unless the caller is
 *     `doric`. Any other contract is refused with `not_owner` unless the
 *     caller's catalog `provides` lists it (`bind().catalog(call)`).
 *   - A contract not found by `hooksOf` answers `invalid_input`.
 *   - Another bundle serving the definition answers `registration_conflict`.
 *   - The same instance again answers the same id.
 *   - A first serving definition sends `available: true` on every open
 *     `WatchAvailability` of the contract.
 * - `Register`:
 *   - Accepted whether or not the contract is defined yet. When `hooksOf`
 *     knows the contract and it has no hook named `hook`, the answer is
 *     `invalid_input`.
 *   - The same instance and `(contract, hook)` again replace `order` and keep
 *     the id.
 * - `Unregister`:
 *   - Removes a definition or a handler when the caller's bundle made it. An
 *     unknown id, or another bundle's, is a no-op.
 *   - Removing the last definition sends `available: false`. Handlers stay
 *     registered.
 * - `Run`:
 *   - `not_owner` unless the caller's bundle serves the contract's
 *     definition. `invalid_input` for a hook the contract lacks, or an input
 *     whose `typeUrl` does not name the hook's message.
 *   - The handlers are the serving handler registration of each bundle for
 *     `(contract, hook)`. Those with an `order` run first, ascending. The rest
 *     follow in catalog order (`doric` first, a bundle not in the order last),
 *     then registration order, and the hook's `reverse` order reverses this
 *     part.
 *   - Each handler runs through
 *     `bind().handler(HookHandlerService, registrant).handle({ contract,
 *     hook, input })`.
 *   - Kind semantics:
 *     - **observe, transform, decide:** each call has a `timeoutMs` of the
 *       hook deadline. A failure is reported as `hook_handler_failed` and a
 *       deadline as `hook_handler_timeout`, both to
 *       `doric.diagnostics/v1` with `bundleId` the handler's bundle and
 *       details `{ contract, hook }`, and the run goes on.
 *     - **transform:** chains `output`. A missing `output`, or one of
 *       another type, is reported as `hook_handler_failed`, and the previous
 *       value is kept. The answer is the final value, the input itself when
 *       no handler ran.
 *     - **decide:** answers the first `decision` with `allow: false`, or
 *       `{ allow: true }`. A missing decision is reported and is not a
 *       refusal.
 *     - **sequence:** awaits each handler with no deadline of its own (the
 *       `Run` call's deadline only). The first failure fails the `Run` with
 *       its Doric code, and the later handlers do not run.
 *   - observe and sequence answer `{}`. Aborting the `Run` call rejects it.
 * - `WatchAvailability`: whether a live instance serves the contract's
 *   definition, the present state first, then one item per change, until
 *   the call ends.
 */
export const createHooksService = (
  bind: () => CoreBinding,
  types: () => Registry,
  deadlineMs: number,
): {
  readonly implementation: ServiceImpl<typeof HooksService>;
  readonly registrations: InstanceRegistrations;
  /**
   * Defines `contract` (one `core` provides; no catalog check) for `core`'s
   * own `instance`, in process, as `Define` would. Answers the
   * registration id. Throws only a `ContractError` `registration_conflict`
   * when another bundle serves the definition.
   */
  defineOwn(instance: BundleInstance, contract: string): string;
  /**
   * Runs `hook` of `core`'s own `contract` in process, as `Run` does for a
   * caller that serves the definition. Rejects as `Run` does.
   */
  runOwn(
    call: Call,
    request: {
      readonly contract: string;
      readonly hook: string;
      readonly input: Any;
    },
  ): Promise<RunResponse>;
} => {
  const table = new RegistrationTable<HookRegistration>({
    conflictCode: 'registration_conflict',
  });
  /** The bundle that made each registration still held, for `Unregister`. */
  const owners = new Map<string, string>();
  /** The open `WatchAvailability` streams: their contract and last item. */
  const watchers = new Set<{
    readonly contract: string;
    available: boolean;
    readonly push: (available: boolean) => void;
  }>();

  /** The serving definition of `contract`, when an instance serves one. */
  const definitionOf = (
    contract: string,
  ): RegistrationEntry<HookRegistration> | undefined =>
    table
      .entries()
      .find(
        ({ key, value }) => value.kind === 'definition' && key === contract,
      );

  /** Tells every watcher whose contract's availability changed. */
  const notify = (): void => {
    for (const watcher of watchers) {
      const available = definitionOf(watcher.contract) !== undefined;

      if (available !== watcher.available) {
        watcher.available = available;
        watcher.push(available);
      }
    }
  };

  const define = (caller: StampedCaller, contract: string): string => {
    const { registrationId } = table.register(caller, contract, {
      kind: 'definition',
      contract,
    });

    owners.set(registrationId, caller.bundleId);
    notify();

    return registrationId;
  };

  /** The shape of `hook` of `contract`; `invalid_input` when it has none. */
  const shapeOf = (contract: string, hook: string): HookShape => {
    const shape = hooksOf(types(), contract)?.get(hook);

    if (shape === undefined) {
      throw new ContractError(
        'invalid_input',
        `The hooks contract ${contract} has no hook ${hook}.`,
        { contract, hook },
      );
    }

    return shape;
  };

  /** Runs `hook` of `contract` for `call`, once its caller may. */
  const run = async (
    call: Call,
    request: {
      readonly contract: string;
      readonly hook: string;
      readonly input: Any | undefined;
    },
  ): Promise<MessageInitShape<typeof RunResponseSchema>> => {
    const binding = bind();
    const { contract, hook, input } = request;
    const shape = shapeOf(contract, hook);

    if (input === undefined || !anyIs(input, shape.typeName)) {
      throw new ContractError(
        'invalid_input',
        `The input of ${contract} ${hook} is not a ${shape.typeName}.`,
        { contract, hook, typeUrl: input?.typeUrl ?? '' },
      );
    }

    const handlers = table
      .entries()
      .filter(
        ({ value }) =>
          value.kind === 'handler' &&
          value.contract === contract &&
          value.hook === hook,
      );
    const orderOf = ({ value }: RegistrationEntry<HookRegistration>) =>
      value.kind === 'handler' ? value.order : undefined;
    const ordered = handlers
      .filter((entry) => orderOf(entry) !== undefined)
      .sort((left, right) => (orderOf(left) ?? 0) - (orderOf(right) ?? 0));
    const { order } = await binding.catalog(call);
    const rankOf = (bundleId: string): number => {
      const index = order.indexOf(bundleId);

      return bundleId === 'doric' ? -1 : index < 0 ? order.length : index;
    };
    const unordered = handlers
      .filter((entry) => orderOf(entry) === undefined)
      .sort(
        (left, right) =>
          rankOf(left.caller.bundleId) - rankOf(right.caller.bundleId),
      );

    if (shape.order === 'reverse') {
      unordered.reverse();
    }

    const handle = (
      entry: RegistrationEntry<HookRegistration>,
      current: Any,
      bounded: boolean,
    ) =>
      binding.handler(HookHandlerService, entry.caller).handle(
        { contract, hook, input: current },
        {
          signal: call.signal,
          ...(bounded && deadlineMs > 0 ? { timeoutMs: deadlineMs } : {}),
        },
      );
    const report = (
      entry: RegistrationEntry<HookRegistration>,
      kind: 'hook_handler_failed' | 'hook_handler_timeout',
      message: string,
    ) =>
      binding.report(
        {
          bundleId: entry.caller.bundleId,
          kind,
          message,
          details: { contract, hook },
        },
        call,
      );
    let current = input;

    for (const entry of [...ordered, ...unordered]) {
      call.signal.throwIfAborted();

      if (shape.kind === 'sequence') {
        try {
          await handle(entry, current, false);
        } catch (error) {
          throw error instanceof ConnectError
            ? fromConnectError(error)
            : error;
        }

        continue;
      }

      let answer: Awaited<ReturnType<typeof handle>>;

      try {
        answer = await handle(entry, current, true);
      } catch (error) {
        call.signal.throwIfAborted();
        await report(
          entry,
          error instanceof ConnectError && error.code === Code.DeadlineExceeded
            ? 'hook_handler_timeout'
            : 'hook_handler_failed',
          messageOf(error),
        );
        continue;
      }

      if (shape.kind === 'transform') {
        if (answer.output === undefined) {
          await report(
            entry,
            'hook_handler_failed',
            `The handler answered no output for ${contract} ${hook}.`,
          );
        } else if (!anyIs(answer.output, shape.typeName)) {
          await report(
            entry,
            'hook_handler_failed',
            `The handler answered a ${answer.output.typeUrl}, not a ${shape.typeName}.`,
          );
        } else {
          current = answer.output;
        }
      } else if (shape.kind === 'decide') {
        if (answer.decision === undefined) {
          await report(
            entry,
            'hook_handler_failed',
            `The handler answered no decision for ${contract} ${hook}.`,
          );
        } else if (!answer.decision.allow) {
          return { decision: answer.decision };
        }
      }
    }

    return shape.kind === 'transform'
      ? { output: current }
      : shape.kind === 'decide'
        ? { decision: { allow: true } }
        : {};
  };

  const implementation: ServiceImpl<typeof HooksService> = {
    define: async ({ contract }, context) => {
      const binding = bind();
      const call = callOf(context);
      const caller = stampedCallerOf(context);
      const owns = contract.startsWith('doric.')
        ? caller.bundleId === 'doric'
        : (await binding.catalog(call))
            .provides(caller.bundleId)
            .has(contract);

      if (!owns) {
        throw new ContractError(
          'not_owner',
          `Bundle ${caller.bundleId} does not provide ${contract}.`,
          { contract },
        );
      }

      if (hooksOf(types(), contract) === undefined) {
        throw new ContractError(
          'invalid_input',
          `No hooks contract ${contract} is known.`,
          { contract },
        );
      }

      return { registrationId: define(caller, contract) };
    },
    register: ({ contract, hook, order }, context) => {
      bind();

      const caller = stampedCallerOf(context);
      const shapes = hooksOf(types(), contract);

      if (shapes !== undefined && !shapes.has(hook)) {
        shapeOf(contract, hook);
      }

      const { registrationId } = table.register(
        caller,
        `${contract}\u0000${hook}\u0000${caller.bundleId}`,
        { kind: 'handler', contract, hook, order },
      );

      owners.set(registrationId, caller.bundleId);

      return { registrationId };
    },
    unregister: ({ registrationId }, context) => {
      bind();

      if (owners.get(registrationId) === callOf(context).caller.bundleId) {
        table.remove(registrationId);
        owners.delete(registrationId);
        notify();
      }

      return {};
    },
    run: ({ contract, hook, input }, context) => {
      bind();

      const call = callOf(context);

      if (definitionOf(contract)?.caller.bundleId !== call.caller.bundleId) {
        throw new ContractError(
          'not_owner',
          `Bundle ${call.caller.bundleId} does not serve ${contract}.`,
          { contract },
        );
      }

      return run(call, { contract, hook, input });
    },
    async *watchAvailability({ contract }, context) {
      bind();

      const inbox = createInbox<boolean>(context.signal);
      const watcher = {
        contract,
        available: definitionOf(contract) !== undefined,
        push: inbox.push,
      };

      watchers.add(watcher);

      try {
        yield { available: watcher.available };

        for (
          let available = await inbox.next();
          available !== undefined;
          available = await inbox.next()
        ) {
          yield { available };
        }
      } finally {
        watchers.delete(watcher);
      }
    },
  };

  return {
    implementation,
    registrations: {
      dropInstance: (instance) => {
        table.dropInstance(instance);
        notify();
      },
    },
    defineOwn: (instance, contract) =>
      define({ ...instance, version: '' }, contract),
    runOwn: async (call, request) => {
      const { output, decision } = await run(call, request);

      return create(RunResponseSchema, {
        ...(output === undefined ? {} : { output }),
        ...(decision === undefined ? {} : { decision }),
      });
    },
  };
};
