// The conversation's `check` and `map` for `createErrorReporter`
// (conversation-openui.md D29, openui.md D7, D18), in the renderer chunk.
// One statement per line is assumed (D5), so a statement's name is the
// identifier before `=` on its line.

import type {
  OpenUIErrorCodeName,
  OpenUIErrorLike,
  ProgramRevision,
  ReportedError,
} from '../contracts/index.js';
import type { ChatFenceView } from './chat-contract.js';
import { diagramCheck, mergeDiagramErrors } from './diagram/check.js';
import { parseProgram } from './library.js';
import { questionOf } from './question/ask-input.js';

/** `ask`'s refusal in a subagent's Thread (`threads/src/host/tools/ask.ts`). */
const REFUSED =
  'Not asked: only the main thread can ask the user. Put the question in your result instead, so your coordinator can ask the user or decide.';

/** D7's hint after an `unknown-component` message. */
const HINT =
  'Repository components and Export exist only in papercraft fences.';

/** The longest message a report carries. */
const MAX_MESSAGE = 300;

const STATEMENT = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=/;

/** Each statement line of `program`, with its name. */
const statements = (
  program: string,
): readonly { readonly name: string; readonly line: string }[] =>
  program.split('\n').flatMap((line) => {
    const name = STATEMENT.exec(line)?.[1];
    return name === undefined ? [] : [{ name, line }];
  });

type Parsed = ReturnType<typeof parseProgram> | undefined;

/** `program` parsed once for the whole check; `undefined` when it does not parse. */
const parse = (program: string): Parsed => {
  try {
    return parseProgram(program);
  } catch {
    // A program the parser cannot read reaches `onError` as OpenUI's own error.
    return undefined;
  }
};

/** The `Query` and `Mutation` statements of a parse; none when it did not parse. */
const toolStatements = (parsed: Parsed): readonly string[] =>
  parsed === undefined
    ? []
    : [...parsed.queryStatements, ...parsed.mutationStatements].map(
        ({ statementId }) => statementId,
      );

const programOf = (revision: ProgramRevision): string =>
  typeof revision.program === 'string' ? revision.program : '';

/**
 * `Query`/`Mutation`, `@OpenUrl` and an `AskForm` off the root when the
 * fence is not a question (D29), without the diagram findings.
 */
const ownErrors = (
  revision: ProgramRevision,
  parsed: Parsed,
): readonly ReportedError[] => {
  const lines = statements(programOf(revision));
  const errors: ReportedError[] = toolStatements(parsed).map((statementId) => ({
    code: 'tool-not-found',
    statementId,
    message:
      'Query and Mutation are not available; write the data as literals.',
  }));

  for (const { name, line } of lines) {
    if (line.includes('@OpenUrl(')) {
      errors.push({
        code: 'runtime-error',
        statementId: name,
        message: 'OpenUrl is disabled; write the link as text',
      });
    }
  }

  if (!revision.question) {
    for (const { name, line } of lines) {
      if (line.includes('AskForm(')) {
        errors.push({
          code: 'runtime-error',
          statementId: name,
          message:
            'A question must be the root of its own fence: write root = AskForm(…) as its first line.',
        });
      }
    }
  }
  return errors;
};

/**
 * The program half of `check`: `Query`/`Mutation`, `@OpenUrl`, an `AskForm`
 * off the root when the fence is not a question (D29), and the diagram
 * findings merged into them (openui-diagrams.md F3). The reader's card
 * shows these.
 */
export const programCheck = (
  revision: ProgramRevision,
): readonly ReportedError[] => {
  const parsed = parse(programOf(revision));
  return mergeDiagramErrors(
    ownErrors(revision, parsed),
    diagramCheck(parsed?.root),
  );
};

/**
 * The question half of `check`: the refusal in an agent's Thread and the
 * invalid-question line of a closed question fence (D29).
 */
export const questionCheck = (
  view: ChatFenceView,
  revision: ProgramRevision,
): readonly ReportedError[] => {
  if (!revision.question) return [];
  if (view.origin === 'agent') {
    return [{ code: 'runtime-error', statementId: 'root', message: REFUSED }];
  }
  if (view.fence.state !== 'closed') return [];
  const read = questionOf(programOf(revision));
  if (read.input !== undefined) return [];
  return [
    {
      code: 'runtime-error',
      statementId: 'root',
      message: `Invalid question: ${read.issue ?? ''}`.slice(0, MAX_MESSAGE),
    },
  ];
};

/** The conversation's own check of a fence's program, run once, at its report (D29). */
export const check = (
  view: ChatFenceView,
  revision: ProgramRevision,
): readonly ReportedError[] => {
  const parsed = parse(programOf(revision));
  return mergeDiagramErrors(
    [...ownErrors(revision, parsed), ...questionCheck(view, revision)],
    diagramCheck(parsed?.root),
  );
};

/** OpenUI's error as reported: its message, with D7's hint for `unknown-component`, cut to 300 characters. */
export const map = (error: OpenUIErrorLike): ReportedError => {
  // The hint is kept whole: OpenUI's message is cut to leave it room.
  const message =
    error.code === 'unknown-component'
      ? `${error.message.slice(0, MAX_MESSAGE - HINT.length - 1)} ${HINT}`
      : error.message;
  return {
    code: error.code as OpenUIErrorCodeName,
    ...(error.statementId === undefined
      ? {}
      : { statementId: error.statementId }),
    message: message.slice(0, MAX_MESSAGE),
  };
};
