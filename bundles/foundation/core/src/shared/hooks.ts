import {
  type AnyHookHandler,
  type Call,
  type Cleanup,
  ContractError,
  type Disposable,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  deadlineOf,
  decisionSchema,
  defineMethod,
  defineService,
  generationOf,
  type HooksContract,
  HooksV1,
  hooksMethods,
  isPlatformContract,
  type Services,
} from 'bundle/contracts';

import { seenBy, viewOf } from './partition.js';

/** How long one hook handler may run before the chain moves on. */
export const DEFAULT_HOOK_DEADLINE_MS = 10_000;

/** The platform's window hooks follow their own deadline rules (hooks.md). */
const WINDOW_HOOKS = 'doric.window.hooks/v1';

export interface HooksOptions {
  /** Per-handler deadline; `DEFAULT_HOOK_DEADLINE_MS` unless given. */
  readonly deadlineMs?: number;
}

interface Registration {
  readonly bundleId: string;
  readonly seq: number;
  /** The generation partition of the registering call (D4-11). */
  readonly generation: number;
  /**
   * `scope.windowKey` of the registering call: a `doric.window.hooks/v1`
   * handler runs only for calls of its own window (stage 9, §4.7).
   */
  readonly windowKey: string | undefined;
  readonly handler: AnyHookHandler;
}

interface Waiter {
  // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
  readonly callback: () => void | Cleanup;
  /** Whether the callback ran for the current definition. */
  ran: boolean;
  cleanup?: Cleanup;
  /** Handler registrations made while the callback ran. */
  readonly registrations: Set<Registration>;
}

interface ContractState {
  owner?: string;
  contract?: HooksContract;
  /** Shared by every generation's state of the same contract ID. */
  readonly handlers: Map<string, Registration[]>;
  readonly waiters: Set<Waiter>;
}

const once = (dispose: () => void): Disposable => {
  let done = false;

  return {
    dispose: () => {
      if (!done) {
        done = true;
        dispose();
      }
    },
  };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const timedOut = Symbol('timed-out');

/** Waits for one handler, bounded by `deadlineMs` (0 means no deadline). */
const bounded = async (
  run: () => unknown,
  deadlineMs: number,
): Promise<unknown> => {
  const result = Promise.resolve().then(run);

  if (deadlineMs <= 0) {
    return await result;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      result,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Rejects with the call's abort reason when it aborts first. */
const abortable = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);

    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
};

/**
 * The core's `hooks/v1`: ownership checked against the catalog, handlers run
 * in catalog order (the platform first), each bounded by a deadline, and every
 * handler failure or timeout reported to diagnostics instead of failing the
 * owner's `execute`.
 */
export const createHooks = (options: HooksOptions = {}) => {
  const deadlineMs = options.deadlineMs ?? DEFAULT_HOOK_DEADLINE_MS;
  const states = new Map<string, ContractState>();
  /** Handlers by contract ID; each carries its generation (D4-11). */
  const handlerMaps = new Map<string, Map<string, Registration[]>>();
  /** Registrations made while a `whenDefined` callback runs, synchronously. */
  let collecting: Set<Registration> | undefined;
  let seq = 0;

  const handlersOf = (id: string): Map<string, Registration[]> => {
    let handlers = handlerMaps.get(id);

    if (handlers === undefined) {
      handlers = new Map();
      handlerMaps.set(id, handlers);
    }

    return handlers;
  };

  /**
   * The definition state of a contract in one generation: a bundle hooks
   * contract has one per `(id, generation)`, so two generations of the same
   * owner never collide; a platform (`doric.*`) contract has one shared state.
   */
  const stateOf = (id: string, generation: number): ContractState => {
    const key =
      isPlatformContract(id) || generation === 0 ? id : `${id}@@${generation}`;
    let state = states.get(key);

    if (state === undefined) {
      state = { handlers: handlersOf(id), waiters: new Set() };
      states.set(key, state);
    }

    return state;
  };

  const remove = (state: ContractState, hook: string, entry: Registration) => {
    const remaining = (state.handlers.get(hook) ?? []).filter(
      (item) => item !== entry,
    );

    state.handlers.set(hook, remaining);
  };

  const report = (
    services: Services,
    bundleId: string,
    kind: string,
    message: string,
    details: Record<string, unknown>,
  ) => {
    try {
      services
        .use(DoricDiagnosticsV1)
        .report({ bundleId, kind, message, details });
    } catch {
      // Diagnostics are best effort; a hook chain never fails over them.
    }
  };

  const run = (waiter: Waiter) => {
    const previous = collecting;

    collecting = waiter.registrations;

    try {
      const result = waiter.callback();

      waiter.ran = true;

      if (typeof result === 'function') {
        waiter.cleanup = result;
      }
    } finally {
      collecting = previous;
    }
  };

  const undefine = (state: ContractState) => {
    state.owner = undefined;
    state.contract = undefined;

    for (const waiter of state.waiters) {
      if (!waiter.ran) {
        continue;
      }

      waiter.ran = false;

      const cleanup = waiter.cleanup;

      waiter.cleanup = undefined;

      for (const registration of waiter.registrations) {
        for (const [hook, entries] of state.handlers) {
          if (entries.includes(registration)) {
            remove(state, hook, registration);
          }
        }
      }

      waiter.registrations.clear();
      void Promise.resolve()
        .then(() => cleanup?.())
        .catch(() => undefined);
    }
  };

  return defineService(HooksV1, {
    define: defineMethod({
      input: hooksMethods.define.input,
      output: hooksMethods.define.output,
      execute: (contract: HooksContract, call: Call, services: Services) => {
        const owner = call.caller.bundleId;

        if (isPlatformContract(contract.id)) {
          if (owner !== 'doric') {
            throw new ContractError(
              'not_owner',
              `Bundle "${owner}" cannot define the platform hooks ${contract.id}.`,
            );
          }
        } else {
          const bundle = services
            .use(DoricCatalogV1)
            .get(call)
            .bundles.find(({ id }) => id === owner);

          if (
            bundle?.manifest?.provides.some((entry) =>
              entry.startsWith(`${contract.id}@`),
            ) !== true
          ) {
            throw new ContractError(
              'not_owner',
              `Bundle "${owner}" does not list ${contract.id} in provides.`,
            );
          }
        }

        const state = stateOf(contract.id, generationOf(call));

        if (state.owner !== undefined && state.owner !== owner) {
          throw new ContractError(
            'registration_conflict',
            `${contract.id} is already defined by "${state.owner}".`,
          );
        }

        if (state.owner === owner) {
          return once(() => undefined);
        }

        state.owner = owner;
        state.contract = contract;

        for (const waiter of state.waiters) {
          run(waiter);
        }

        return once(() => {
          if (state.owner === owner) {
            undefine(state);
          }
        });
      },
    }),
    register: defineMethod({
      input: hooksMethods.register.input,
      output: hooksMethods.register.output,
      execute: ([contract, hook, handler], call) => {
        const generation = generationOf(call);
        const state = stateOf(contract.id, generation);
        const entry: Registration = {
          bundleId: call.caller.bundleId,
          seq: seq++,
          generation,
          windowKey: call.scope?.windowKey,
          handler,
        };

        state.handlers.set(hook, [...(state.handlers.get(hook) ?? []), entry]);
        collecting?.add(entry);

        return once(() => remove(state, hook, entry));
      },
    }),
    whenDefined: defineMethod({
      input: hooksMethods.whenDefined.input,
      output: hooksMethods.whenDefined.output,
      execute: ([contract, callback], call) => {
        const state = stateOf(contract.id, generationOf(call));
        const waiter: Waiter = {
          callback,
          ran: false,
          registrations: new Set(),
        };

        state.waiters.add(waiter);

        if (state.owner !== undefined) {
          run(waiter);
        }

        return once(() => {
          state.waiters.delete(waiter);

          for (const registration of waiter.registrations) {
            for (const [hook, entries] of state.handlers) {
              if (entries.includes(registration)) {
                remove(state, hook, registration);
              }
            }
          }

          waiter.registrations.clear();

          if (waiter.ran) {
            waiter.ran = false;
            void Promise.resolve()
              .then(() => waiter.cleanup?.())
              .catch(() => undefined);
          }
        });
      },
    }),
    execute: defineMethod({
      input: hooksMethods.execute.input,
      output: hooksMethods.execute.output,
      execute: ([contract, hook, input], call, services) => {
        const definition = contract.hooks[hook];

        if (definition === undefined) {
          throw new ContractError(
            'invalid_input',
            `${contract.id} has no hook "${hook}".`,
          );
        }

        const parsed = definition.input.safeParse(input);

        if (!parsed.success) {
          throw new ContractError(
            'invalid_input',
            `Invalid input for ${contract.id} ${hook}: ${parsed.error.message}`,
            { issues: parsed.error.issues },
          );
        }

        const order = services.use(DoricCatalogV1).get(call).order;
        const rank = (bundleId: string) =>
          bundleId === 'doric' ? -1 : order.indexOf(bundleId);
        const view = viewOf(call, services);
        const handlers = (handlersOf(contract.id).get(hook) ?? [])
          .filter(
            (entry) =>
              seenBy(entry.generation, view) &&
              (contract.id !== WINDOW_HOOKS ||
                entry.windowKey === call.scope?.windowKey),
          )
          .sort(
            (left, right) =>
              rank(left.bundleId) - rank(right.bundleId) ||
              left.seq - right.seq,
          );
        const limit =
          contract.id === WINDOW_HOOKS
            ? hook === 'onCloseHook'
              ? 0
              : Math.max(0, deadlineOf(call) - Date.now())
            : deadlineMs;
        const details = { contract: contract.id, hook };

        // A sequence step is the owner's own work: each handler is awaited
        // without a deadline, and the first failure rejects the execution.
        const sequence = async (): Promise<unknown> => {
          const ordered =
            definition.order === 'reverse' ? [...handlers].reverse() : handlers;

          for (const entry of ordered) {
            await entry.handler(parsed.data, call);
          }

          return undefined;
        };

        const chain = async (): Promise<unknown> => {
          if (definition.kind === 'sequence') {
            return await sequence();
          }

          let value: unknown = parsed.data;

          for (const entry of handlers) {
            let result: unknown;
            // An observe hook may give each owner a narrower view of its input,
            // or skip the owner when the payload is not for it.
            const delivered =
              definition.kind === 'observe' && definition.forOwner !== undefined
                ? definition.forOwner(value, entry.bundleId)
                : value;

            if (delivered === undefined) {
              continue;
            }

            try {
              result = await bounded(
                () => entry.handler(delivered, call),
                limit,
              );
            } catch (error) {
              report(
                services,
                entry.bundleId,
                'hook_handler_failed',
                messageOf(error),
                details,
              );
              continue;
            }

            if (result === timedOut) {
              report(
                services,
                entry.bundleId,
                'hook_handler_timeout',
                `${hook} handler did not settle within ${limit} ms.`,
                details,
              );
              continue;
            }

            if (definition.kind === 'transform') {
              const next = definition.input.safeParse(result);

              if (next.success) {
                value = next.data;
              } else {
                report(
                  services,
                  entry.bundleId,
                  'hook_handler_failed',
                  `${hook} handler returned an invalid value: ${next.error.message}`,
                  details,
                );
              }
            } else if (definition.kind === 'decide') {
              const decision = decisionSchema.safeParse(result);

              if (!decision.success) {
                report(
                  services,
                  entry.bundleId,
                  'hook_handler_failed',
                  `${hook} handler returned an invalid decision: ${decision.error.message}`,
                  details,
                );
              } else if (!decision.data.allow) {
                return decision.data;
              }
            }
          }

          if (definition.kind === 'transform') {
            return value;
          }

          return definition.kind === 'decide' ? { allow: true } : undefined;
        };

        return abortable(chain(), call.signal);
      },
    }),
  });
};
