// Wire ↔ domain for `openui`'s host part as a process (phase 3, S56, D2):
// each routed request is decoded to JSON and parsed again with today's zod
// schema, so the kernel's limits and the questions' digest stay the same.

import { type MessageInitShape, toJson } from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';
import type { InputSource } from 'runtime/contracts';
import type { OnPromptStartedHookInput } from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';
import type { z } from 'zod';

import {
  type ReportErrorsRequest,
  ReportErrorsRequestSchema,
} from '../contracts/gen/doric/openui/programs/v1/programs_pb.js';
import {
  type AnswerRequest,
  AnswerRequestSchema,
  type QuestionStateSchema,
  type StatusRequest,
  StatusRequestSchema,
} from '../contracts/gen/doric/openui/questions/v1/questions_pb.js';
import {
  type ProgramErrorsInput,
  programErrorsInputSchema,
  type QuestionAnswerInput,
  type QuestionRef,
  type QuestionState,
  questionAnswerInputSchema,
  questionRefSchema,
} from '../contracts/index.js';
import type { PromptStartedInput } from './validation.js';

/** `json` parsed with `schema`; a refusal is `invalid_input` naming the contract and method. */
const parsed = <T>(schema: z.ZodType<T>, json: unknown, method: string): T => {
  const result = schema.safeParse(json);

  if (!result.success) {
    throw new ContractError(
      'invalid_input',
      `Invalid input for openui.${method}.`,
      { issues: result.error.issues },
    );
  }

  return result.data;
};

/**
 * Request decoders: `toJson(Schema, request)` parsed with today's zod schema.
 * Throw `ContractError('invalid_input', 'Invalid input for openui.<contract>
 * <method>.', {issues})` when the schema refuses it (a blank-by-`trim` text, a
 * length over the UTF-16 limit, …). The answer is today's domain value, keys
 * in schema order, unset optional fields absent (so `digestOf` equals the
 * kernel's).
 */
export const programErrorsInputOf = (
  request: ReportErrorsRequest,
): ProgramErrorsInput =>
  parsed(
    programErrorsInputSchema,
    toJson(ReportErrorsRequestSchema, request, { alwaysEmitImplicit: true }),
    'programs/v1 reportErrors',
  );

export const questionRefOf = (request: StatusRequest): QuestionRef =>
  parsed(
    questionRefSchema,
    toJson(StatusRequestSchema, request, { alwaysEmitImplicit: true }),
    'questions/v1 status',
  );

export const questionAnswerInputOf = (
  request: AnswerRequest,
): QuestionAnswerInput =>
  parsed(
    questionAnswerInputSchema,
    toJson(AnswerRequestSchema, request, { alwaysEmitImplicit: true }),
    'questions/v1 answer',
  );

/** `{state:'pending'}` → `{state: {case: 'pending', value: {}}}`; `answered` → `{case: 'answered', value: {answers}}`. Never throws. */
export const questionStateMessageOf = (
  state: QuestionState,
): MessageInitShape<typeof QuestionStateSchema> =>
  state.state === 'pending'
    ? { state: { case: 'pending', value: {} } }
    : {
        state: {
          case: 'answered',
          value: {
            answers: state.answers.map((answer) => ({
              id: answer.id,
              options: [...answer.options],
              ...(answer.other === undefined ? {} : { other: answer.other }),
            })),
          },
        },
      };

/**
 * The hook input as the registry reads it: `{threadId, promptId, source}`
 * with `source` today's `InputSource` (`kind` = the oneof case, the case's
 * fields beside it; `bundle` keeps `bundleId`, `reason`, `retain?`). Throws
 * `ContractError('invalid_input')` for a source with no case.
 */
export const promptStartedOf = (
  input: OnPromptStartedHookInput,
): PromptStartedInput => ({
  threadId: input.threadId,
  promptId: input.promptId,
  source: inputSourceOf(input.source?.kind),
});

/** Today's `InputSource` of a hook input's `source.kind`. */
const inputSourceOf = (
  kind: NonNullable<OnPromptStartedHookInput['source']>['kind'] | undefined,
): InputSource => {
  switch (kind?.case) {
    case 'user':
      return { kind: 'user' };
    case 'terminal':
      return {
        kind: 'terminal',
        terminalId: kind.value.terminalId,
        promptId: kind.value.promptId,
      };
    case 'parent':
      return {
        kind: 'parent',
        threadId: kind.value.threadId,
        promptId: kind.value.promptId,
      };
    case 'result':
      return {
        kind: 'result',
        threadId: kind.value.threadId,
        promptId: kind.value.promptId,
        requestPromptId: kind.value.requestPromptId,
      };
    case 'bundle':
      return {
        kind: 'bundle',
        bundleId: kind.value.bundleId,
        reason: kind.value.reason,
        ...(kind.value.retain === true ? { retain: true } : {}),
      };
    default:
      throw new ContractError(
        'invalid_input',
        'The prompt start has no source.',
      );
  }
};
