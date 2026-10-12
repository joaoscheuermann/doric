import {
  ContractError,
  type Disposable,
  defineMethod,
  defineService,
  type RegisteredSkill,
  SkillsV1,
  skillsMethods,
  ToolsV1,
} from 'bundle/contracts';

import { collidesIn, seenBy, viewOf } from '../shared/partition.js';

interface Entry {
  readonly generation: number;
  readonly registered: RegisteredSkill;
}

/** Ordered entries first, by key; ties and unordered keep registration order. */
const byOrder = (left: Entry, right: Entry): number =>
  (left.registered.order ?? Number.POSITIVE_INFINITY) -
    (right.registered.order ?? Number.POSITIVE_INFINITY) || 0;

/**
 * The core's `skills/v1`: canonical skill records (decoded by SkillSchema)
 * sorted by the global `order` key, then registration order (which the loader
 * keeps in bundle order), with unique names and `allowed-tools` resolved
 * against every tool the caller's tools/v1 list holds (1.1.0, D10-6), all
 * within one generation view (D4-11): the kernel partition plus one generation.
 */
export const createSkills = () => {
  const registered: Entry[] = [];

  return defineService(SkillsV1, {
    register: defineMethod({
      input: skillsMethods.register.input,
      output: skillsMethods.register.output,
      execute: ([skill, options], call, services): Disposable => {
        const bundleId = call.caller.bundleId;
        const view = viewOf(call, services);
        const taken = registered.find(
          (entry) =>
            entry.registered.skill.name === skill.name &&
            collidesIn(entry.generation, view),
        )?.registered;

        if (taken !== undefined) {
          throw new ContractError(
            'duplicate_skill',
            `Duplicate skill name "${skill.name}": bundle "${taken.bundleId}" and bundle "${bundleId}".`,
          );
        }

        const available = new Set(
          services
            .use(ToolsV1)
            .list(call)
            .map((entry) => entry.tool.name),
        );

        for (const name of skill.allowedTools) {
          if (!available.has(name)) {
            throw new ContractError(
              'unavailable_tool',
              `Skill "${skill.name}" in bundle "${bundleId}" references unavailable tool "${name}".`,
            );
          }
        }

        const entry: Entry = {
          generation: view.generation,
          registered: Object.freeze({
            bundleId,
            alwaysAvailable: options?.alwaysAvailable ?? false,
            ...(options?.order === undefined ? {} : { order: options.order }),
            skill,
          }),
        };

        registered.push(entry);

        let disposed = false;

        return {
          dispose: () => {
            if (disposed) {
              return;
            }

            disposed = true;

            const index = registered.indexOf(entry);

            if (index >= 0) {
              registered.splice(index, 1);
            }
          },
        };
      },
    }),
    list: defineMethod({
      input: skillsMethods.list.input,
      output: skillsMethods.list.output,
      execute: async (_input, call, services) => {
        await Promise.resolve();

        const view = viewOf(call, services);

        return registered
          .filter((entry) => seenBy(entry.generation, view))
          .sort(byOrder)
          .map((entry) => entry.registered);
      },
    }),
  });
};
