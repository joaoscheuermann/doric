// Validation feedback in the host (openui.md D18): the errors windows report
// through `openui.programs/v1` are kept per Thread, for both tags, and reach
// the agent at the start of the Thread's next prompt as one `validation`
// instruct.

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';
import { RuntimeThreadsV1 } from 'runtime/contracts';

import {
  type OpenUIErrorCodeName,
  OpenuiProgramsV1,
  openuiProgramsMethods,
  type ProgramErrorsInput,
} from '../contracts/index.js';

/** D18's fixed text of each code, for an error without `message`. */
export const FIXED_TEXT: Readonly<Record<OpenUIErrorCodeName, string>> = {
  'missing-required': 'omits a required argument',
  'null-required': 'passes null for a required argument',
  'unknown-component': 'calls a component the library does not have',
  'inline-reserved': 'uses a call inline that must be a statement of its own',
  'excess-args':
    'passes more arguments than the component takes; the extra ones were dropped',
  'type-mismatch': 'passes an argument of the wrong type',
  'unknown-function': 'calls a function or action that does not exist here',
  'no-root': 'has no root statement',
  'runtime-error': 'failed while its values were evaluated',
  'render-error': 'failed while it was drawn',
  'parse-exception': 'could not be parsed',
  'parse-failed': 'is not valid OpenUI Lang; a program starts with root = …',
  'tool-not-found':
    'calls a tool that is not available; write the data as literals',
  'tool-error': 'calls a tool that failed',
  'mcp-error': 'calls a tool server that failed',
};

/** The instruct's opening text, before its lines. */
export const OPENING =
  'Some OpenUI fences you wrote have errors. Each line is `<tag> <identity> r<revision> <statement>: <code> <text>`. Fix a program by writing a fence with the same tag and identity: a patch of the named statements, or the whole program when you no longer see it.';

/** The most lines one instruct lists. */
const MAX_LINES = 50;

/** The most Threads the host keeps an entry for. */
const MAX_THREADS = 1000;

/** One Thread's pending lines, for both tags. */
interface Entry {
  readonly promptId: string;
  readonly previousPromptId?: string;
  readonly lines: string[];
  /** Line ids already listed: tag, key, code and statement (or the cut-off mark). */
  readonly seen: Set<string>;
  dropped: number;
}

/** The prompt of a fence key: the part before the first `/`. */
const promptOf = (key: string): string => key.slice(0, key.indexOf('/'));

/** The prompt of a `seen` id, which starts with the tag and the key as JSON. */
const seenPromptOf = (id: string): string =>
  promptOf((JSON.parse(id) as readonly string[])[1] ?? '');

const scopeOf = (call: Call): { readonly threadId: string } => {
  const { projectId, threadId } = call.scope ?? {};

  if (projectId === undefined || threadId === undefined) {
    throw new ContractError(
      'invalid_scope',
      'openui.programs/v1 needs a call scope with a project and a Thread.',
    );
  }

  return { threadId };
};

/** The entries of every Thread, and the hook and service over them. */
export const createValidation = () => {
  // Insertion order is prompt start order: the first entry started longest ago.
  const entries = new Map<string, Entry>();

  const add = (entry: Entry, id: string, line: string): void => {
    if (entry.seen.has(id)) return;
    entry.seen.add(id);
    if (entry.lines.length < MAX_LINES) entry.lines.push(line);
    else entry.dropped += 1;
  };

  const report = (threadId: string, input: ProgramErrorsInput): void => {
    const entry = entries.get(threadId);
    const prompt = promptOf(input.key);

    if (
      entry === undefined ||
      (prompt !== entry.promptId && prompt !== entry.previousPromptId)
    ) {
      return;
    }

    const head = `${input.tag} ${input.identity} r${input.revision}`;
    for (const error of input.errors) {
      add(
        entry,
        JSON.stringify([
          input.tag,
          input.key,
          error.code,
          error.statementId ?? '',
        ]),
        `${head} ${error.statementId ?? '-'}: ${error.code} ${
          error.message ?? FIXED_TEXT[error.code]
        }`,
      );
    }
    if (input.state === 'unterminated') {
      add(
        entry,
        JSON.stringify([input.tag, input.key, 'unterminated']),
        `${head}: cut off before the fence closed`,
      );
    }
  };

  /** `onPromptStartedHook`: one instruct when the entry has lines, then a fresh entry. */
  const promptStarted = async (
    services: Services,
    input: { readonly threadId: string; readonly promptId: string },
    call: Call,
  ): Promise<void> => {
    const entry = entries.get(input.threadId);
    entries.delete(input.threadId);

    if (entries.size >= MAX_THREADS) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }

    entries.set(input.threadId, {
      promptId: input.promptId,
      ...(entry === undefined ? {} : { previousPromptId: entry.promptId }),
      lines: [],
      seen: new Set(
        [...(entry?.seen ?? [])].filter(
          (id) => seenPromptOf(id) === entry?.promptId,
        ),
      ),
      dropped: 0,
    });

    if (entry === undefined || entry.lines.length === 0) return;

    const more =
      entry.dropped > 0
        ? `\n\nand ${entry.dropped} more errors were not listed`
        : '';
    await services.use(RuntimeThreadsV1).instruct(
      {
        id: input.threadId,
        prompt: `${OPENING}\n\n${entry.lines.join('\n')}${more}`,
        reason: 'validation',
        promptId: input.promptId,
      },
      call,
    );
  };

  const service = () =>
    defineService(OpenuiProgramsV1, {
      reportErrors: defineMethod({
        ...openuiProgramsMethods.reportErrors,
        execute: (input: ProgramErrorsInput, call: Call): Promise<void> =>
          Promise.resolve().then(() => {
            report(scopeOf(call).threadId, input);
          }),
      }),
    });

  return { promptStarted, service };
};
