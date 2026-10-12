import { z } from 'zod';

export interface SkillSchemaInput {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly allowedTools: readonly string[];
  readonly indexText?: string;
}

export interface SkillRecord {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly allowedTools: readonly string[];
  readonly indexText: string;
}

const nonEmpty = z.string().trim().min(1);

const input = z
  .object({
    name: nonEmpty,
    description: nonEmpty,
    body: nonEmpty,
    allowedTools: z.array(nonEmpty),
    indexText: z.string().optional(),
  })
  .strict();

/** The canonical, decoded skill record. */
export const skillRecordSchema = z
  .object({
    name: nonEmpty,
    description: nonEmpty,
    body: nonEmpty,
    allowedTools: z.array(nonEmpty),
    indexText: z.string(),
  })
  .strict();

const normalizeSkill = (
  value: z.output<typeof input>,
): z.input<typeof skillRecordSchema> => {
  const allowedTools = [...new Set(value.allowedTools)];

  return {
    name: value.name,
    description: value.description,
    body: value.body,
    allowedTools,
    indexText: `${value.name} | ${value.description} | ${allowedTools.join(',')} | ${value.body}`,
  };
};

/** JSON-Schema-compatible canonical representation of a bundle skill. */
export const SkillSchema = z.codec(input, skillRecordSchema, {
  decode: normalizeSkill,
  encode: (value) => value,
});
