// The core's `skills/v1` over the router: skills as data, kept with the
// router-stamped registering instance under D4's key rule.

import { create } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import {
  type Call,
  ContractError,
  callOf,
  skillsMethods,
} from 'bundle/contracts';
import {
  type RegisteredSkill,
  RegisteredSkillSchema,
  type SkillsService,
} from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import type { RegisteredTool } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { RegistrationTable, stampedCallerOf } from 'bundle/host';

import { describeIssues } from '../../shared/issues.js';
import type { CoreBinding } from '../binding.js';
import type { InstanceRegistrations } from '../tools/service.js';

/**
 * `skills/v1` as `createCoreServices` serves it, with a
 * `RegistrationTable<…>({ conflictCode: 'duplicate_skill' })` keyed by the
 * skill name.
 *
 * - `Register`:
 *   - Decodes `skill` with today's `skillsMethods.register.input`, so
 *     `allowedTools` loses duplicates and `indexText` is built when absent.
 *     A refusal answers `invalid_input`.
 *   - A name another bundle serves answers `duplicate_skill` with today's
 *     message.
 *   - An `allowedTools` entry not among `tools.visible(call)` names answers
 *     `unavailable_tool` with today's message. The Register call's scope
 *     picks the Project.
 *   - The same instance and name again replace the skill and keep the id.
 * - `Unregister`: as `tools/v1`.
 * - `List`: every serving skill, sorted by `order` ascending, then the
 *   unordered ones in the order their names were first registered.
 *   `alwaysAvailable` is false when absent.
 */
export const createSkillsService = (
  bind: () => CoreBinding,
  tools: { visible(call: Call): readonly RegisteredTool[] },
): {
  readonly implementation: ServiceImpl<typeof SkillsService>;
  readonly registrations: InstanceRegistrations;
} => {
  const table = new RegistrationTable<RegisteredSkill>({
    conflictCode: 'duplicate_skill',
  });
  /** The bundle that made each registration still held, for `Unregister`. */
  const owners = new Map<string, string>();

  const implementation: ServiceImpl<typeof SkillsService> = {
    register: ({ skill, options }, context) => {
      bind();

      const parsed = skillsMethods.register.input.safeParse([
        {
          name: skill?.name,
          description: skill?.description,
          body: skill?.body,
          allowedTools: skill?.allowedTools,
          ...(skill?.indexText === undefined
            ? {}
            : { indexText: skill.indexText }),
        },
        options === undefined
          ? undefined
          : {
              ...(options.alwaysAvailable === undefined
                ? {}
                : { alwaysAvailable: options.alwaysAvailable }),
              ...(options.order === undefined ? {} : { order: options.order }),
            },
      ]);

      if (!parsed.success) {
        throw new ContractError(
          'invalid_input',
          `Invalid skill: ${describeIssues(parsed.error)}`,
        );
      }

      const [record, decodedOptions] = parsed.data;
      const call = callOf(context);
      const caller = stampedCallerOf(context);
      const taken = table
        .entries()
        .find(
          (entry) =>
            entry.key === record.name &&
            entry.caller.bundleId !== caller.bundleId,
        );

      if (taken !== undefined) {
        throw new ContractError(
          'duplicate_skill',
          `Duplicate skill name "${record.name}": bundle "${taken.caller.bundleId}" and bundle "${caller.bundleId}".`,
        );
      }

      const available = new Set(
        tools.visible(call).flatMap(({ tool }) => tool?.name ?? []),
      );

      for (const name of record.allowedTools) {
        if (!available.has(name)) {
          throw new ContractError(
            'unavailable_tool',
            `Skill "${record.name}" in bundle "${caller.bundleId}" references unavailable tool "${name}".`,
          );
        }
      }

      const { registrationId } = table.register(
        caller,
        record.name,
        create(RegisteredSkillSchema, {
          bundleId: caller.bundleId,
          alwaysAvailable: decodedOptions?.alwaysAvailable ?? false,
          ...(decodedOptions?.order === undefined
            ? {}
            : { order: decodedOptions.order }),
          skill: {
            name: record.name,
            description: record.description,
            body: record.body,
            allowedTools: [...record.allowedTools],
            indexText: record.indexText,
          },
        }),
      );

      owners.set(registrationId, caller.bundleId);

      return { registrationId };
    },
    unregister: ({ registrationId }, context) => {
      bind();

      if (owners.get(registrationId) === callOf(context).caller.bundleId) {
        table.remove(registrationId);
        owners.delete(registrationId);
      }

      return {};
    },
    list: () => {
      bind();

      return {
        skills: table
          .entries()
          .map(({ value }) => value)
          .sort(
            (left, right) =>
              (left.order ?? Number.POSITIVE_INFINITY) -
                (right.order ?? Number.POSITIVE_INFINITY) || 0,
          ),
      };
    },
  };

  return {
    implementation,
    registrations: {
      dropInstance: (instance) => table.dropInstance(instance),
    },
  };
};
