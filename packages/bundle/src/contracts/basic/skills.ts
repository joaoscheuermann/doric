import { z } from 'zod';

import type { CallArg } from '../call.js';
import type { Disposable } from '../context.js';
import { ref } from '../define.js';
import {
  type SkillRecord,
  SkillSchema,
  type SkillSchemaInput,
  skillRecordSchema,
} from '../skill.js';
import { disposableSchema, type MethodSpecs, noInput } from './common.js';
import { orderKeySchema } from './tools.js';

export interface RegisteredSkill {
  readonly bundleId: string;
  readonly alwaysAvailable: boolean;
  /** The global position the skill declared (1.1.0); absent when unordered. */
  readonly order?: number;
  readonly skill: SkillRecord;
}

export interface SkillRegistrationOptions {
  readonly alwaysAvailable?: boolean;
  /**
   * Global position in `list()` (1.1.0), ascending; the loader passes the
   * SKILL.md frontmatter `order`. Unordered skills follow every ordered one.
   */
  readonly order?: number;
}

export interface Skills {
  /**
   * Validates with SkillSchema; throws 'duplicate_skill' for a taken name and
   * 'unavailable_tool' when an allowedTools entry is not a tool the caller's
   * tools/v1 list holds, whichever bundle registered it (1.1.0).
   */
  register(
    skill: SkillSchemaInput,
    options?: SkillRegistrationOptions,
  ): Disposable;
  /** Sorted by `order` (unordered last), then bundle order, then registration order. */
  list(call?: CallArg): Promise<readonly RegisteredSkill[]>;
}

export const SkillsV1 = ref<Skills>('skills/v1');

export const registeredSkillSchema = z
  .object({
    bundleId: z.string(),
    alwaysAvailable: z.boolean(),
    order: orderKeySchema.optional(),
    skill: skillRecordSchema,
  })
  .strict();

export const skillsMethods = {
  register: {
    input: z.tuple([
      SkillSchema,
      z
        .object({
          alwaysAvailable: z.boolean().optional(),
          order: orderKeySchema.optional(),
        })
        .strict()
        .optional(),
    ]),
    output: disposableSchema,
  },
  list: {
    input: noInput,
    output: z.array(registeredSkillSchema),
  },
} as const satisfies MethodSpecs;
