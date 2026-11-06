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

/** The `Query` and `Mutation` statements of `program`; none when it does not parse. */
const toolStatements = (program: string): readonly string[] => {
  let parsed: ReturnType<typeof parseProgram>;
  try {
    parsed = parseProgram(program);
  } catch {
    // A program the parser cannot read reaches `onError` as OpenUI's own error.
    return [];
  }
  return [...parsed.queryStatements, ...parsed.mutationStatements].map(
    ({ statementId }) => statementId,
  );
};

/** The conversation's own check of a fence's program, run once, at its report (D29). */
export const check = (
  view: ChatFenceView,
  revision: ProgramRevision,
): readonly ReportedError[] => {
  const program = typeof revision.program === 'string' ? revision.program : '';
  const lines = statements(program);
  const errors: ReportedError[] = toolStatements(program).map(
    (statementId) => ({
      code: 'tool-not-found',
      statementId,
      message:
        'Query and Mutation are not available; write the data as literals.',
    }),
  );

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
    return errors;
  }

  if (view.origin === 'agent') {
    errors.push({
      code: 'runtime-error',
      statementId: 'root',
      message: REFUSED,
    });
  } else if (view.fence.state === 'closed') {
    const read = questionOf(program);
    if (read.input === undefined) {
      errors.push({
        code: 'runtime-error',
        statementId: 'root',
        message: `Invalid question: ${read.issue ?? ''}`.slice(0, MAX_MESSAGE),
      });
    }
  }
  return errors;
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
