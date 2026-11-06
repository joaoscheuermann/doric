// `openui.programs/v1` (openui.md D18): the one sink of fence errors for both
// tags, provided by the `openui` host and exposed to the desktop with the
// scope `projectId`, `threadId`.

import { type CallArg, type MethodSpecs, ref } from 'bundle/contracts';
import { z } from 'zod';

import {
  FENCE_KEY_PATTERN,
  MAX_ERROR_MESSAGE,
  MAX_REPORTED_ERRORS,
  OPENUI_ERROR_CODES,
  PROGRAM_TAGS,
  type ProgramErrorsInput,
  type ReportedError,
  STATEMENT_ID_PATTERN,
} from './errors.js';
import { PROGRAM_IDENTITY_PATTERN } from './identity.js';

export const reportedErrorSchema = z
  .object({
    code: z.enum(OPENUI_ERROR_CODES),
    statementId: z.string().regex(STATEMENT_ID_PATTERN).optional(),
    message: z.string().min(1).max(MAX_ERROR_MESSAGE).optional(),
  })
  .strict() satisfies z.ZodType<ReportedError, ReportedError>;

export const programErrorsInputSchema = z
  .object({
    tag: z.enum(PROGRAM_TAGS),
    key: z.string().regex(FENCE_KEY_PATTERN),
    identity: z.string().regex(PROGRAM_IDENTITY_PATTERN),
    revision: z.number().int().min(1),
    state: z.enum(['closed', 'unterminated']),
    errors: z.array(reportedErrorSchema).max(MAX_REPORTED_ERRORS),
  })
  .strict() satisfies z.ZodType<ProgramErrorsInput, ProgramErrorsInput>;

/**
 * `openui.programs/v1` (host), exposed to the desktop.
 *
 * Errors: `invalid_input` for an input that fails `programErrorsInputSchema`.
 */
export interface ProgramErrors {
  /**
   * Keeps the report's errors for the Thread's next prompt start, where they
   * reach the agent as one `validation` instruct. A report whose key's prompt
   * is neither the Thread's current nor previous started prompt, or for a
   * Thread the host has not seen start a prompt, is dropped without error.
   * Each error (by tag, key, code and statement) is delivered at most once.
   */
  reportErrors(input: ProgramErrorsInput, call?: CallArg): Promise<void>;
}

export const openuiProgramsMethods = {
  reportErrors: {
    input: programErrorsInputSchema,
    output: z.void(),
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;

export const OpenuiProgramsV1 = ref<ProgramErrors>('openui.programs/v1');
