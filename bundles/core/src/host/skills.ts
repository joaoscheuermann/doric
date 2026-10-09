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

/**
 * The core's `skills/v1`: canonical skill records (decoded by SkillSchema) in
 * bundle order, with unique names and `allowed-tools` resolved only against
 * the tools the same bundle registered.
 */
export const createSkills = () => {
  const registered: RegisteredSkill[] = [];

  return defineService(SkillsV1, {
    register: defineMethod({
      input: skillsMethods.register.input,
      output: skillsMethods.register.output,
      execute: ([skill, options], call, services): Disposable => {
        const bundleId = call.caller.bundleId;
        const taken = registered.find(
          (entry) => entry.skill.name === skill.name,
        );

        if (taken !== undefined) {
          throw new ContractError(
            'duplicate_skill',
            `Duplicate skill name "${skill.name}": bundle "${taken.bundleId}" and bundle "${bundleId}".`,
          );
        }

        const local = new Set(
          services
            .use(ToolsV1)
            .list()
            .filter((entry) => entry.bundleId === bundleId)
            .map((entry) => entry.tool.name),
        );

        for (const name of skill.allowedTools) {
          if (!local.has(name)) {
            throw new ContractError(
              'unavailable_tool',
              `Skill "${skill.name}" in bundle "${bundleId}" references unavailable tool "${name}".`,
            );
          }
        }

        const entry: RegisteredSkill = Object.freeze({
          bundleId,
          alwaysAvailable: options?.alwaysAvailable ?? false,
          skill,
        });

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
      execute: async () => {
        await Promise.resolve();

        return [...registered];
      },
    }),
  });
};
