// The core's `skills/v1` over the router: skills as data, kept with the
// router-stamped registering instance under D4's key rule.

import { create } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf, skillsMethods } from 'bundle/contracts';
import {
  type RegisteredSkill,
  RegisteredSkillSchema,
  type SkillsService,
} from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { RegistrationTable, stampedCallerOf } from 'bundle/host';

import { describeIssues } from '../../shared/issues.js';
import type { CoreBinding } from '../binding.js';
import type { InstanceRegistrations } from '../tools/service.js';

/**
 * `skills/v1` (1.3.0) as `createCoreServices` serves it, with a
 * `RegistrationTable<…>({ conflictCode: 'duplicate_skill' })` keyed by the skill name.
 *
 * - `Register`: decodes `skill` with `skillsMethods.register.input` (`allowedTools` loses duplicates, `indexText` is
 *   built when absent; a refusal answers `invalid_input`); a name another bundle serves answers `duplicate_skill`;
 *   `allowedTools` is kept as decoded, whatever `tools/v1` holds; the same instance and name again replace the
 *   skill and keep the id.
 * - `Unregister`: as `tools/v1`.
 * - `List`: every serving skill, sorted by `order` ascending, then the unordered ones in the order their names
 *   were first registered. `alwaysAvailable` is false when absent.
 */
export const createSkillsService = (
  bind: () => CoreBinding,
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
