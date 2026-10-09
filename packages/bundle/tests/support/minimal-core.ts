// The "core mínimo de teste": a small but complete hooks/v1 provider (and
// optional tools/v1 and skills/v1) written only against bundle/contracts and
// doric.* contracts. It proves the loader does not depend on the default core.

import {
  type AnyHookHandler,
  type Call,
  type Cleanup,
  ContractError,
  type ContractTool,
  type Disposable,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  decisionSchema,
  defineMethod,
  defineService,
  type HooksContract,
  HooksV1,
  type HostContext,
  hooksMethods,
  isPlatformContract,
  type RegisteredSkill,
  type RegisteredTool,
  type Services,
  SkillsV1,
  skillsMethods,
  ToolsV1,
  toolsMethods,
} from '../../src/contracts/index.js';
import type { EmbeddedBundle } from '../../src/index.js';

export type MinimalContract = 'hooks/v1' | 'tools/v1' | 'skills/v1';

export interface MinimalCoreOptions {
  readonly id?: string;
  readonly version?: string;
  readonly provides?: readonly MinimalContract[];
  readonly failActivate?: boolean;
  /** Per-handler deadline; the default mirrors a production-like 10 s. */
  readonly hookDeadlineMs?: number;
  /** Records every hooks/v1 call with its caller (for foundation tests). */
  readonly calls?: { method: string; caller: string; contract: string }[];
  /** Extra activation work after the provides (for example a hook handler). */
  readonly extra?: (ctx: HostContext) => void;
}

const disposable = (dispose: () => void): Disposable => {
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
  readonly handler: AnyHookHandler;
}

interface ContractState {
  owner?: string;
  contract?: HooksContract;
  readonly handlers: Map<string, HandlerEntry[]>;
  readonly waiters: Set<{ run: () => void; cleanup?: Cleanup }>;
}

const timeout = Symbol('timeout');

export const createMinimalHooks = (
  options: Pick<MinimalCoreOptions, 'hookDeadlineMs' | 'calls'> = {},
) => {
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
        const handlers = [
          ...(stateOf(contract.id).handlers.get(hook) ?? []),
        ].sort(
          (left, right) =>
            rank(left.bundleId) - rank(right.bundleId) || left.seq - right.seq,
        );
        const report = (bundleId: string, kind: string, message: string) =>
          services.use(DoricDiagnosticsV1).report({
            bundleId,
            kind,
            message,
            details: { contract: contract.id, hook },
          });

        for (const entry of handlers) {
          let timer: ReturnType<typeof setTimeout> | undefined;

          try {
            const result = await Promise.race([
              Promise.resolve(entry.handler(value, call)),
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

export const createMinimalTools = () => {
  const registered: RegisteredTool[] = [];

  return defineService(ToolsV1, {
    register: defineMethod({
      input: toolsMethods.register.input,
      output: toolsMethods.register.output,
      execute: (
        [tool, options]: [ContractTool, { alwaysAvailable: boolean }],
        call,
      ) => {
        const taken = registered.find((entry) => entry.tool.name === tool.name);

        if (taken !== undefined) {
          throw new ContractError(
            'duplicate_tool',
            `Duplicate tool name "${tool.name}": bundle "${taken.bundleId}" and bundle "${call.caller.bundleId}".`,
          );
        }

        const entry: RegisteredTool = {
          bundleId: call.caller.bundleId,
          alwaysAvailable: options.alwaysAvailable,
          tool,
        };

        registered.push(entry);

        return disposable(() => {
          registered.splice(registered.indexOf(entry), 1);
        });
      },
    }),
    list: defineMethod({
      input: toolsMethods.list.input,
      output: toolsMethods.list.output,
      execute: () => Object.freeze([...registered]),
    }),
  });
};

export const createMinimalSkills = () => {
  const registered: RegisteredSkill[] = [];

  return defineService(SkillsV1, {
    register: defineMethod({
      input: skillsMethods.register.input,
      output: skillsMethods.register.output,
      execute: ([skill, options], call, services) => {
        const bundleId = call.caller.bundleId;

        if (registered.some((entry) => entry.skill.name === skill.name)) {
          throw new ContractError(
            'duplicate_skill',
            `Duplicate skill name "${skill.name}".`,
          );
        }

        const tools = new Set(
          services
            .use(ToolsV1)
            .list()
            .filter((entry) => entry.bundleId === bundleId)
            .map((entry) => entry.tool.name),
        );

        for (const name of skill.allowedTools) {
          if (!tools.has(name)) {
            throw new ContractError(
              'unavailable_tool',
              `Skill "${skill.name}" in bundle "${bundleId}" references unavailable tool "${name}".`,
            );
          }
        }

        const entry: RegisteredSkill = {
          bundleId,
          alwaysAvailable: options?.alwaysAvailable ?? false,
          skill,
        };

        registered.push(entry);

        return disposable(() => {
          registered.splice(registered.indexOf(entry), 1);
        });
      },
    }),
    list: defineMethod({
      input: skillsMethods.list.input,
      output: skillsMethods.list.output,
      execute: async () => {
        await Promise.resolve();

        return [...registered];
      },
    }),
  });
};

/** An embedded minimal core (ID `mincore` unless given). */
export const minimalCore = (
  options: MinimalCoreOptions = {},
): EmbeddedBundle => {
  const id = options.id ?? 'mincore';
  const version = options.version ?? '1.0.0';
  const provides = options.provides ?? ['hooks/v1', 'tools/v1', 'skills/v1'];

  return {
    manifest: {
      manifestVersion: 1,
      id,
      version,
      engines: { doric: '^1.0.0' },
      provides: provides.map((contract) => `${contract}@1.0.0`),
      requires: [],
    },
    descriptor: {
      descriptorVersion: 1,
      bundle: { id, version },
      contracts: provides.map((contract) => ({
        id: contract,
        version: '1.0.0',
        kind: 'service' as const,
        environment: 'host' as const,
        cardinality: 'one' as const,
        local: true,
        schema: `schemas/${contract}.json`,
      })),
    },
    host: {
      activate: ({ services }: HostContext) => {
        if (provides.includes('hooks/v1')) {
          services.provide(createMinimalHooks(options));
        }

        if (provides.includes('tools/v1')) {
          services.provide(createMinimalTools());
        }

        if (provides.includes('skills/v1')) {
          services.provide(createMinimalSkills());
        }

        options.extra?.({ services });

        if (options.failActivate === true) {
          throw new Error('mincore failed to activate');
        }
      },
    },
  };
};

/** The default minimal core's host part, for on-disk fixtures. */
export const activate = (ctx: HostContext) =>
  (minimalCore().host as { activate: (ctx: HostContext) => void }).activate(
    ctx,
  );
