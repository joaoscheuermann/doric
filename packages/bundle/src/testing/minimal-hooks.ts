// The minimal hooks/v1 provider of the "core mínimo de teste" (promoted from
// the tests in stage 9 so `minimalUiCore` reuses it): a small but complete
// provider written only against bundle/contracts and doric.* contracts.

import {
  type AnyHookHandler,
  HooksV1,
  hooksMethods,
} from '../contracts/basic/hooks.js';
import { type Call, generationOf } from '../contracts/call.js';
import type { Cleanup, Disposable, Services } from '../contracts/context.js';
import {
  decisionSchema,
  defineMethod,
  defineService,
  type HooksContract,
} from '../contracts/define.js';
import { ContractError } from '../contracts/error.js';
import { isPlatformContract } from '../contracts/ids.js';
import { DoricCatalogV1, DoricDiagnosticsV1 } from '../contracts/platform.js';

export interface MinimalHooksOptions {
  /** Per-handler deadline; the default mirrors a production-like 10 s. */
  readonly hookDeadlineMs?: number;
  /** Records every hooks/v1 call with its caller (for foundation tests). */
  readonly calls?: { method: string; caller: string; contract: string }[];
}

export const disposable = (dispose: () => void): Disposable => {
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

interface HandlerEntry {
  readonly bundleId: string;
  readonly seq: number;
  /** The generation partition of the registering call (0: the kernel's). */
  readonly generation: number;
  readonly handler: AnyHookHandler;
}

interface ContractState {
  owner?: string;
  contract?: HooksContract;
  readonly handlers: Map<string, HandlerEntry[]>;
  readonly waiters: Set<{ run: () => void; cleanup?: Cleanup }>;
}

const timeout = Symbol('timeout');

export const createMinimalHooks = (options: MinimalHooksOptions = {}) => {
  const states = new Map<string, ContractState>();
  let seq = 0;
  const stateOf = (id: string): ContractState => {
    let state = states.get(id);

    if (state === undefined) {
      state = { handlers: new Map(), waiters: new Set() };
      states.set(id, state);
    }

    return state;
  };
  const track = (method: string, call: Call, contract: HooksContract) =>
    options.calls?.push({
      method,
      caller: call.caller.bundleId,
      contract: contract.id,
    });
  const deadline = options.hookDeadlineMs ?? 10_000;

  return defineService(HooksV1, {
    define: defineMethod({
      input: hooksMethods.define.input,
      output: hooksMethods.define.output,
      execute: (contract, call, services: Services) => {
        track('define', call, contract);

        const owner = call.caller.bundleId;
        const state = stateOf(contract.id);

        if (isPlatformContract(contract.id) ? owner !== 'doric' : false) {
          throw new ContractError(
            'not_owner',
            `${owner} cannot define ${contract.id}`,
          );
        }

        if (!isPlatformContract(contract.id)) {
          const bundle = services
            .use(DoricCatalogV1)
            .get()
            .bundles.find(({ id }) => id === owner);

          if (
            !bundle?.manifest?.provides.some((entry) =>
              entry.startsWith(`${contract.id}@`),
            )
          ) {
            throw new ContractError(
              'not_owner',
              `${owner} does not provide ${contract.id}`,
            );
          }
        }

        if (state.owner !== undefined && state.owner !== owner) {
          throw new ContractError(
            'registration_conflict',
            `${contract.id} is owned by ${state.owner}`,
          );
        }

        if (state.owner === owner) {
          return disposable(() => undefined);
        }

        state.owner = owner;
        state.contract = contract;

        for (const waiter of state.waiters) {
          waiter.run();
        }

        return disposable(() => {
          state.owner = undefined;

          for (const waiter of state.waiters) {
            void waiter.cleanup?.();
          }
        });
      },
    }),
    register: defineMethod({
      input: hooksMethods.register.input,
      output: hooksMethods.register.output,
      execute: ([contract, hook, handler], call) => {
        track('register', call, contract);

        const state = stateOf(contract.id);
        const entry: HandlerEntry = {
          bundleId: call.caller.bundleId,
          seq: seq++,
          generation: generationOf(call),
          handler,
        };

        state.handlers.set(hook, [...(state.handlers.get(hook) ?? []), entry]);

        return disposable(() => {
          state.handlers.set(
            hook,
            (state.handlers.get(hook) ?? []).filter((item) => item !== entry),
          );
        });
      },
    }),
    whenDefined: defineMethod({
      input: hooksMethods.whenDefined.input,
      output: hooksMethods.whenDefined.output,
      execute: ([contract, callback], call) => {
        track('whenDefined', call, contract);

        const state = stateOf(contract.id);
        const waiter: { run: () => void; cleanup?: Cleanup } = {
          run: () => {
            const result = callback();

            if (typeof result === 'function') {
              waiter.cleanup = result;
            }
          },
        };

        state.waiters.add(waiter);

        if (state.owner !== undefined) {
          waiter.run();
        }

        return disposable(() => state.waiters.delete(waiter));
      },
    }),
    execute: defineMethod({
      input: hooksMethods.execute.input,
      output: hooksMethods.execute.output,
      execute: async ([contract, hook, input], call, services) => {
        track('execute', call, contract);

        const definition = contract.hooks[hook];

        if (definition === undefined) {
          throw new ContractError(
            'invalid_input',
            `${contract.id} has no hook ${hook}`,
          );
        }

        let value: unknown = definition.input.parse(input);
        const order = services.use(DoricCatalogV1).get().order;
        const rank = (bundleId: string) =>
          bundleId === 'doric' ? -1 : order.indexOf(bundleId);
        // As the core's hooks/v1: a generation's call sees the kernel's
        // handlers and its own; a kernel call sees the active generation's.
        const pinned = generationOf(call);
        const view =
          pinned === 0 ? services.use(DoricCatalogV1).get().generation : pinned;
        const handlers = (stateOf(contract.id).handlers.get(hook) ?? [])
          .filter(
            (entry) => entry.generation === 0 || entry.generation === view,
          )
          .sort(
            (left, right) =>
              rank(left.bundleId) - rank(right.bundleId) ||
              left.seq - right.seq,
          );
        const report = (bundleId: string, kind: string, message: string) =>
          services.use(DoricDiagnosticsV1).report({
            bundleId,
            kind,
            message,
            details: { contract: contract.id, hook },
          });

        // A sequence step: awaited handler by handler, no deadline, and a
        // failure rejects the execution (as the core's hooks/v1 does).
        if (definition.kind === 'sequence') {
          const ordered =
            definition.order === 'reverse' ? [...handlers].reverse() : handlers;

          for (const entry of ordered) {
            await entry.handler(value, call);
          }

          return undefined;
        }

        for (const entry of handlers) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          // As the core's hooks/v1: an observe hook may give each owner its
          // own view of the input, or skip the owner.
          const delivered =
            definition.kind === 'observe' && definition.forOwner !== undefined
              ? definition.forOwner(value, entry.bundleId)
              : value;

          if (delivered === undefined) {
            continue;
          }

          try {
            const result = await Promise.race([
              Promise.resolve(entry.handler(delivered, call)),
              new Promise<typeof timeout>((resolve) => {
                timer = setTimeout(() => resolve(timeout), deadline);
              }),
            ]);

            if (result === timeout) {
              report(
                entry.bundleId,
                'hook_handler_timeout',
                `${hook} timed out`,
              );
              continue;
            }

            if (definition.kind === 'transform') {
              const parsed = definition.input.safeParse(result);

              if (parsed.success) {
                value = parsed.data;
              } else {
                report(
                  entry.bundleId,
                  'hook_handler_failed',
                  'invalid transform output',
                );
              }
            } else if (definition.kind === 'decide') {
              const parsed = decisionSchema.safeParse(result);

              if (!parsed.success) {
                report(
                  entry.bundleId,
                  'hook_handler_failed',
                  'invalid decision',
                );
              } else if (!parsed.data.allow) {
                return parsed.data;
              }
            }
          } catch (error) {
            report(
              entry.bundleId,
              'hook_handler_failed',
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            clearTimeout(timer);
          }
        }

        if (definition.kind === 'transform') {
          return value;
        }

        return definition.kind === 'decide' ? { allow: true } : undefined;
      },
    }),
  });
};
