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
  type HooksContract,
  HooksV1,
  hooksMethods,
  isPlatformContract,
  type Services,
} from 'bundle/contracts';

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
  /** Registrations made while a `whenDefined` callback runs, synchronously. */
  let collecting: Set<Registration> | undefined;
  let seq = 0;

  const stateOf = (id: string): ContractState => {
    let state = states.get(id);

    if (state === undefined) {
      state = { handlers: new Map(), waiters: new Set() };
      states.set(id, state);
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
            .get()
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

        const state = stateOf(contract.id);

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
        const state = stateOf(contract.id);
        const entry: Registration = {
          bundleId: call.caller.bundleId,
          seq: seq++,
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
      execute: ([contract, callback]) => {
        const state = stateOf(contract.id);
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

        const order = services.use(DoricCatalogV1).get().order;
        const rank = (bundleId: string) =>
          bundleId === 'doric' ? -1 : order.indexOf(bundleId);
        const handlers = [
          ...(stateOf(contract.id).handlers.get(hook) ?? []),
        ].sort(
          (left, right) =>
            rank(left.bundleId) - rank(right.bundleId) || left.seq - right.seq,
        );
        const limit =
          contract.id === WINDOW_HOOKS
            ? hook === 'onCloseHook'
              ? 0
              : Math.max(0, deadlineOf(call) - Date.now())
            : deadlineMs;
        const details = { contract: contract.id, hook };

        const chain = async (): Promise<unknown> => {
          let value: unknown = parsed.data;

          for (const entry of handlers) {
            let result: unknown;

            try {
              result = await bounded(() => entry.handler(value, call), limit);
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
