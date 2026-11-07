// Validation feedback in the host (openui.md D18, U50): the errors windows
// report through `openui.programs/v1` are kept per Thread, for both tags, and
// reach the agent in the same turn. A `closed` report is a `validation`
// instruct 200 ms after it arrives, steering the prompt that runs now, within a
// budget of three per prompt that a validation instruct did not start; an `unterminated` report, or
// one the budget or a queued instruct holds, waits for the Thread's next prompt
// start, which gives every waiting line in one instruct.

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';
import { type InputSource, RuntimeThreadsV1 } from 'runtime/contracts';

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

/** How long a `closed` report waits for others before its instruct. */
const REPORT_DELAY_MS = 200;

/** The immediate instructs of one prompt that a validation instruct did not start. */
const MAX_IMMEDIATE = 3;

/** One Thread's pending lines, for both tags. */
interface Entry {
  promptId: string;
  previousPromptId?: string;
  /** Lines for the next immediate instruct. */
  now: string[];
  /** Lines held for the next prompt start. */
  later: string[];
  /** Line ids already listed: tag, key, code and statement (or the cut-off mark). */
  seen: Set<string>;
  dropped: number;
  /** Immediate instructs left until a prompt starts that a validation instruct did not start. */
  budget: number;
  /** The prompt an immediate instruct was queued as, until it starts. */
  queued?: string;
  timer?: ReturnType<typeof setTimeout>;
  flushing: boolean;
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

/** The instruct's text for `lines`, with the count of the ones not listed. */
const promptText = (lines: readonly string[], dropped: number): string => {
  const more =
    dropped > 0 ? `\n\nand ${dropped} more errors were not listed` : '';
  return `${OPENING}\n\n${lines.join('\n')}${more}`;
};

/** Whether `source` is a prompt this bundle's validation instruct queued. */
const isValidationStart = (source: InputSource | undefined): boolean =>
  source?.kind === 'bundle' &&
  source.bundleId === 'openui' &&
  source.reason === 'validation';

/** The entries of every Thread, and the hook and service over them. */
export const createValidation = (services: Services) => {
  // Insertion order is prompt start order: the first entry started longest ago.
  const entries = new Map<string, Entry>();
  let disposed = false;

  const startTimer = (threadId: string, entry: Entry): void => {
    if (disposed || entry.timer !== undefined) return;
    entry.timer = setTimeout(() => {
      void flush(threadId, entry);
    }, REPORT_DELAY_MS);
  };

  const clearTimer = (entry: Entry): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    delete entry.timer;
  };

  /** The timer's immediate instruct of the lines in `now`. */
  const flush = async (threadId: string, entry: Entry): Promise<void> => {
    clearTimer(entry);
    if (entry.flushing || entry.now.length === 0) return;

    const lines = entry.now.splice(0);
    const { dropped } = entry;
    entry.dropped = 0;
    entry.flushing = true;
    entry.budget -= 1;

    const giveBack = (): void => {
      entry.later.unshift(...lines);
      entry.dropped += dropped;
      entry.budget += 1;
    };

    try {
      const result = await services.use(RuntimeThreadsV1).instruct({
        id: threadId,
        prompt: promptText(lines, dropped),
        reason: 'validation',
        promptId: entry.promptId,
      });
      if (result.status === 'queued') entry.queued = result.promptId;
      else if (result.status !== 'steered') giveBack();
    } catch {
      // A failed instruct keeps its lines for the next prompt start.
      giveBack();
    } finally {
      entry.flushing = false;
      if (entry.now.length > 0) startTimer(threadId, entry);
    }
  };

  const add = (
    threadId: string,
    entry: Entry,
    id: string,
    line: string,
    immediate: boolean,
  ): void => {
    if (entry.seen.has(id)) return;
    entry.seen.add(id);
    if (entry.now.length + entry.later.length >= MAX_LINES) {
      entry.dropped += 1;
      return;
    }
    if (!immediate || entry.budget === 0 || entry.queued !== undefined) {
      entry.later.push(line);
      return;
    }
    entry.now.push(line);
    if (entry.now.length === 1) startTimer(threadId, entry);
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

    const immediate = input.state === 'closed';
    const head = `${input.tag} ${input.identity} r${input.revision}`;
    for (const error of input.errors) {
      add(
        threadId,
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
        immediate,
      );
    }
    if (input.state === 'unterminated') {
      add(
        threadId,
        entry,
        JSON.stringify([input.tag, input.key, 'unterminated']),
        `${head}: cut off before the fence closed`,
        false,
      );
    }
  };

  /** `onPromptStartedHook`: the entry moves to the new prompt and gives every waiting line in one instruct. */
  const promptStarted = async (
    input: {
      readonly threadId: string;
      readonly promptId: string;
      readonly source?: InputSource;
    },
    call: Call,
  ): Promise<void> => {
    const found = entries.get(input.threadId);
    entries.delete(input.threadId);

    const entry: Entry = found ?? {
      promptId: input.promptId,
      now: [],
      later: [],
      seen: new Set(),
      dropped: 0,
      budget: MAX_IMMEDIATE,
      flushing: false,
    };
    entries.set(input.threadId, entry);

    if (entries.size > MAX_THREADS) {
      const [oldestId, oldest] = entries.entries().next().value ?? [];
      if (oldestId !== undefined && oldest !== undefined) {
        clearTimer(oldest);
        entries.delete(oldestId);
      }
    }

    if (found !== undefined) {
      entry.previousPromptId = found.promptId;
      entry.promptId = input.promptId;
      const previous = entry.previousPromptId;
      entry.seen = new Set(
        [...entry.seen].filter((id) => seenPromptOf(id) === previous),
      );
    }
    clearTimer(entry);
    if (entry.queued === input.promptId) delete entry.queued;
    if (!isValidationStart(input.source)) entry.budget = MAX_IMMEDIATE;

    if (entry.flushing || entry.later.length + entry.now.length === 0) return;

    const lines = [...entry.later.splice(0), ...entry.now.splice(0)];
    const { dropped } = entry;
    entry.dropped = 0;
    await services.use(RuntimeThreadsV1).instruct(
      {
        id: input.threadId,
        prompt: promptText(lines, dropped),
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

  /** Stops every pending timer; no instruct starts after. */
  const dispose = (): void => {
    disposed = true;
    for (const entry of entries.values()) clearTimer(entry);
  };

  return { promptStarted, service, dispose };
};
