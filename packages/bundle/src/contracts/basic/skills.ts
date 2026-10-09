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

export interface RegisteredSkill {
  readonly bundleId: string;
  readonly alwaysAvailable: boolean;
  readonly skill: SkillRecord;
}

export interface SkillRegistrationOptions {
  readonly alwaysAvailable?: boolean;
}

export interface Skills {
  /**
   * Validates with SkillSchema; throws 'duplicate_skill' for a taken name and
   * 'unavailable_tool' when an allowedTools entry is not a tool registered in
   * tools/v1 by the calling bundle.
   */
  register(
    skill: SkillSchemaInput,
    options?: SkillRegistrationOptions,
  ): Disposable;
  /** Bundle order, then registration order. */
  list(call?: CallArg): Promise<readonly RegisteredSkill[]>;
}

export const SkillsV1 = ref<Skills>('skills/v1');

export const registeredSkillSchema = z
  .object({
    bundleId: z.string(),
    alwaysAvailable: z.boolean(),
    skill: skillRecordSchema,
  })
  .strict();

export const skillsMethods = {
  register: {
    input: z.tuple([
      SkillSchema,
      z.object({ alwaysAvailable: z.boolean().optional() }).strict().optional(),
    ]),
    output: disposableSchema,
  },
  list: {
    input: noInput,
    output: z.array(registeredSkillSchema),
  },
} as const satisfies MethodSpecs;
