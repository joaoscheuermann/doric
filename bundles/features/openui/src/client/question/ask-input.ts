// D21's reading of a question fence's program (conversation-openui.md D21),
// in the renderer chunk: the one reading the question form, the
// conversation's check and supersession share.

import {
  type AskInput,
  type AskQuestion,
  askInputSchema,
  askQuestionSchema,
} from '../../contracts/index.js';
import { parseProgram } from '../library.js';

export interface QuestionRead {
  /** The root as `AskInput`, when the mapped root passes `askInputSchema`. */
  readonly input?: AskInput;
  /** Otherwise, the first zod issue's message. */
  readonly issue?: string;
  /** The entries of the root's `questions` that pass `askQuestionSchema`, in order. */
  readonly questions: readonly AskQuestion[];
}

/**
 * Parses `program` with the conversation library and maps its root: an
 * `AskForm` element to `{ questions, context }`, each `AskQuestion` and
 * `AskOption` to its fields, leaving `undefined` props out and any other value
 * as it is. Exactly one of `input` and `issue` is set. Never throws.
 */
export const questionOf = (program: string): QuestionRead => {
  let root: unknown;
  try {
    root = parseProgram(program).root;
  } catch (error) {
    return {
      issue: error instanceof Error ? error.message : String(error),
      questions: [],
    };
  }
  const mapped = mapNode(root);
  const parsed = askInputSchema.safeParse(mapped);
  const entries =
    isRecord(mapped) && Array.isArray(mapped.questions) ? mapped.questions : [];
  const questions = entries.flatMap((entry: unknown) => {
    const question = askQuestionSchema.safeParse(entry);
    return question.success ? [question.data] : [];
  });
  return parsed.success
    ? { input: parsed.data, questions }
    : {
        issue: parsed.error.issues[0]?.message ?? 'Invalid question',
        questions,
      };
};

/** The fields of each built-in, in D21's argument order. */
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  AskForm: ['questions', 'context'],
  AskQuestion: ['id', 'question', 'options', 'multiSelect', 'allowOther'],
  AskOption: ['label', 'description', 'recommended'],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An element node of a built-in as its fields, `undefined` props left out; any other value as it is. */
const mapNode = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(mapNode);
  if (
    !isRecord(value) ||
    value.type !== 'element' ||
    typeof value.typeName !== 'string' ||
    !isRecord(value.props)
  ) {
    return value;
  }
  const fields = FIELDS[value.typeName];
  if (fields === undefined) return value;
  const props = value.props;
  return Object.fromEntries(
    fields.flatMap((field) =>
      props[field] === undefined ? [] : [[field, mapNode(props[field])]],
    ),
  );
};
