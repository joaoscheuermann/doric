// The "core mínimo de teste": a small but complete hooks/v1 provider (and
// optional tools/v1 and skills/v1) written only against bundle/contracts and
// doric.* contracts. It proves the loader does not depend on the default core.

import {
  ContractError,
  type ContractTool,
  defineMethod,
  defineService,
  type HostContext,
  type RegisteredSkill,
  type RegisteredTool,
  SkillsV1,
  skillsMethods,
  ToolsV1,
  toolsMethods,
} from '../../src/contracts/index.js';
import type { EmbeddedBundle } from '../../src/index.js';
import {
  createMinimalHooks,
  disposable,
} from '../../src/testing/minimal-hooks.js';

export { createMinimalHooks };

export type MinimalContract = 'hooks/v1' | 'tools/v1' | 'skills/v1';

export interface MinimalCoreOptions {
  readonly id?: string;
  readonly version?: string;
  readonly provides?: readonly MinimalContract[];
  /** Manifest `requires` entries, such as `storage.backend/v1@^1.0.0`. */
  readonly requires?: readonly string[];
  readonly failActivate?: boolean;
  /** Per-handler deadline; the default mirrors a production-like 10 s. */
  readonly hookDeadlineMs?: number;
  /** Records every hooks/v1 call with its caller (for foundation tests). */
  readonly calls?: { method: string; caller: string; contract: string }[];
  /** Extra activation work after the provides (for example a hook handler). */
  readonly extra?: (ctx: HostContext) => void;
}

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
    catalog: defineMethod({
      input: toolsMethods.catalog.input,
      output: toolsMethods.catalog.output,
      execute: async () =>
        registered.map(({ tool }) => ({
          name: tool.name,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          settings: tool.settings,
        })),
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

        // skills/v1 1.1.0: any tool the tools/v1 list holds (D10-6).
        const tools = new Set(
          services
            .use(ToolsV1)
            .list()
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
          ...(options?.order === undefined ? {} : { order: options.order }),
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
      requires: [...(options.requires ?? [])],
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
