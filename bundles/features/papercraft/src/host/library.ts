// The per-Thread entry of D10 and D28: the `papercraft.cwd/v1` bindings read
// so far, the last bound `cwd`, the two runtime hooks that append the event
// and give the library instruct, and the binding of a fence by its
// `turnSequence`.

import { createHash } from 'node:crypto';

import { ContractError, EventsV1, type Services } from 'bundle/contracts';
import {
  type CwdChanged,
  type PromptStarted,
  RuntimeThreadsV1,
  type ThreadEvent,
} from 'runtime/contracts';

import { cwdEvent } from '../contracts/index.js';
import type { LibraryComponent } from '../sandbox/protocol.js';
import type { LastAnswer, MemoEntry, ProgramsHost } from './programs.js';

/** The reason the library instruct is given under (D28). */
export const LIBRARY_REASON = 'library';

/** The longest library instruct text (D28), in UTF-16 code units. */
export const MAX_INSTRUCT_CHARS = 16_000;

export interface LibraryHooks {
  /**
   * `onPromptStartedHook` (D10, D28): reads the Thread's new events, appends
   * `papercraft.cwd/v1` when `cwd` differs from the last bound one, and, once
   * the Thread has loaded the papercraft skill, runs one library job and gives
   * the retained instruct. Never
   * rejects: a failed step ends or skips as D10 says.
   */
  promptStarted(input: PromptStarted): Promise<void>;
  /**
   * `onThreadCwdChangedHook`: as `promptStarted`, only when the input carries
   * a `promptId`, and without a library job of its own.
   */
  cwdChanged(input: CwdChanged): Promise<void>;
  /**
   * The `cwd` of the Thread's last `papercraft.cwd/v1` event whose sequence
   * is below `turnSequence`, after rewinds; `undefined` when none.
   */
  bindingAt(threadId: string, turnSequence: number): string | undefined;
  /**
   * `bindingAt`, after reading the Thread's events past the entry's cursor
   * when `turnSequence` is above it (D10): `ProgramsDeps.cwdAt` of a
   * `library` call, which may come before any hook of this host session.
   * Never rejects: a failed read answers from the bindings read so far.
   */
  cwdAt(
    scope: { readonly projectId: string; readonly threadId: string },
    turnSequence: number,
  ): Promise<string | undefined>;
}

/** D28's per-Thread entry, with D10's bindings. */
interface ThreadEntry {
  cursor: number;
  skillLoadedAt?: number;
  bindings: { readonly sequence: number; readonly cwd: string }[];
  lastInstruct?: { readonly root: string | null; readonly digest?: string };
  /** The reads of the Thread's events, one at a time. */
  reading: Promise<void>;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/** Applies the events read after the cursor: cwd pairs, the skill load, rewinds. */
const apply = (entry: ThreadEntry, events: readonly ThreadEvent[]): void => {
  for (const { sequence, type, event } of events) {
    const body = record(event);

    if (type === 'history.truncated') {
      const after = Number(body?.afterSequence);
      if (!Number.isFinite(after)) continue;

      entry.bindings = entry.bindings.filter((pair) => pair.sequence <= after);
      if (entry.skillLoadedAt !== undefined && entry.skillLoadedAt > after) {
        delete entry.skillLoadedAt;
      }
      if (entry.lastInstruct !== undefined) {
        entry.lastInstruct = { root: entry.lastInstruct.root };
      }
      continue;
    }

    if (type === cwdEvent.type) {
      const cwd = body?.cwd;
      if (typeof cwd === 'string') entry.bindings.push({ sequence, cwd });
      continue;
    }

    const call = record(body?.call);

    if (
      type === 'tool.started' &&
      call?.name === 'load_skill' &&
      record(call.payload)?.name === 'papercraft'
    ) {
      entry.skillLoadedAt ??= sequence;
    }
  }
};

/**
 * Creates the hooks over one programs host and provides its
 * `papercraft.programs/v1`, whose `library` binds through them; each call
 * holds its own entries.
 */
export const createLibraryHooks = (
  services: Services,
  programs: ProgramsHost,
): LibraryHooks => {
  const entries = new Map<string, ThreadEntry>();

  // The hooks hold the bindings `papercraft.programs/v1.library` reads, so
  // they serve it. A second set of hooks over the same services (a host
  // restarted over a live log) leaves the first provider in place.
  try {
    services.provide(programs.service);
  } catch (error) {
    if (
      !(error instanceof ContractError && error.code === 'provider_conflict')
    ) {
      throw error;
    }
  }

  const entryOf = (threadId: string): ThreadEntry => {
    let entry = entries.get(threadId);
    if (entry === undefined) {
      entry = { cursor: 0, bindings: [], reading: Promise.resolve() };
      entries.set(threadId, entry);
    }

    return entry;
  };

  /** Reads and applies the events after the cursor; rejects when the read fails. */
  const read = (threadId: string, entry: ThreadEntry): Promise<void> => {
    const next = entry.reading.then(async () => {
      const log = await services
        .use(RuntimeThreadsV1)
        .threadEvents({ id: threadId, afterSequence: entry.cursor });

      if (log === undefined) return;
      apply(entry, log.events);
      entry.cursor = Math.max(entry.cursor, log.lastSequence);
    });
    entry.reading = next.catch(() => undefined);

    return next;
  };

  const bindingAt = (
    threadId: string,
    turnSequence: number,
  ): string | undefined =>
    entries
      .get(threadId)
      ?.bindings.filter((pair) => pair.sequence < turnSequence)
      .at(-1)?.cwd;

  /** D28's four steps; `job` only at a prompt start. */
  const hook = async (
    input: {
      readonly projectId: string;
      readonly threadId: string;
      readonly promptId: string;
      readonly cwd: string;
    },
    job: boolean,
  ): Promise<void> => {
    const { projectId, threadId, promptId, cwd } = input;
    const entry = entryOf(threadId);

    // 1. The events after the cursor; a failed read ends the hook.
    try {
      await read(threadId, entry);
    } catch {
      return;
    }

    // 2. The cwd event, when the directory differs from the last binding.
    if (cwd !== entry.bindings.at(-1)?.cwd) {
      try {
        await services
          .use(EventsV1, { projectId, threadId, promptId })
          .append(cwdEvent, { cwd });
      } catch {
        // `lastCwd` changes only through events read: the next hook appends.
      }
    }

    if (entry.skillLoadedAt === undefined) return;

    // 3. The library instruct, when its text changed.
    const answer = programs.lastAnswerOf(projectId, cwd);
    const text = instructText(
      answer,
      answer !== undefined && 'root' in answer
        ? programs.memoOf(projectId, answer.root)
        : undefined,
      entry.lastInstruct?.root,
    );

    if (text !== undefined) {
      const digest = createHash('sha256').update(text.text).digest('hex');

      if (digest !== entry.lastInstruct?.digest) {
        try {
          const given = await services.use(RuntimeThreadsV1).instruct({
            id: threadId,
            prompt: text.text,
            reason: LIBRARY_REASON,
            promptId,
            retain: true,
          });

          // A refused instruct records nothing, so the next hook tries again.
          if (given.status === 'steered' || given.status === 'queued') {
            entry.lastInstruct = { root: text.root, digest };
          }
        } catch {
          // Recorded nothing: the next hook gives it again.
        }
      }
    }

    // 4. A library job for the working directory, not awaited.
    if (job) void programs.libraryFor(projectId, cwd);
  };

  return {
    promptStarted: (input) => hook(input, true),
    cwdChanged: async (input) => {
      const { promptId } = input;
      if (promptId === undefined) return;

      await hook({ ...input, promptId }, false);
    },
    bindingAt,
    cwdAt: async ({ threadId }, turnSequence) => {
      const entry = entryOf(threadId);

      if (turnSequence > entry.cursor) {
        await read(threadId, entry).catch(() => undefined);
      }

      return bindingAt(threadId, turnSequence);
    },
  };
};

/** D8's line for a schema folder a repository rule hides (D28). */
const ignoredLine = (ignoredBy: string): string =>
  `Git ignores these schema files (\`${ignoredBy}\`), so they are not versioned. Tell the reader. Removing that rule keeps Doric's app state out of Git, because each Doric folder under \`.doric/\` has its own \`.gitignore\`.`;

const alsoLine = (names: readonly string[]): string =>
  `Also: ${names.join(', ')}; read their schema files for their props.`;

/** D28's text for a ready root, within `MAX_INSTRUCT_CHARS`. */
const readyText = (
  root: string,
  components: readonly LibraryComponent[],
  ignoredBy: string | undefined,
): string => {
  const lines = [
    `Repository library at ${root}: ${String(components.length)} components.`,
  ];
  const ignored = ignoredBy === undefined ? [] : [ignoredLine(ignoredBy)];
  let also: string[] = [];

  for (const [index, component] of components.entries()) {
    const line = `${component.signature} — ${component.description}`;
    const rest = components.slice(index + 1).map(({ name }) => name);
    const candidate = [
      ...lines,
      line,
      ...ignored,
      ...(rest.length > 0 ? [alsoLine(rest)] : []),
    ];

    if (candidate.join('\n').length > MAX_INSTRUCT_CHARS) {
      also = [alsoLine(components.slice(index).map(({ name }) => name))];
      break;
    }

    lines.push(line);
  }

  return [...lines, ...ignored, ...also].join('\n');
};

/**
 * D28's instruct text for a `cwd`'s last answer and its memo entry, at most
 * `MAX_INSTRUCT_CHARS` long, with the `root` the Thread's entry records (`null`
 * for `none` and for a failure without a root); `undefined` when there is
 * nothing to say (no answer yet, or `none` after no earlier root).
 */
export const instructText = (
  answer: LastAnswer | undefined,
  entry: MemoEntry | undefined,
  lastRoot: string | null | undefined,
): { readonly root: string | null; readonly text: string } | undefined => {
  if (answer === undefined) return undefined;

  if ('root' in answer) {
    if (entry?.error !== undefined) {
      return {
        root: answer.root,
        text: `The repository library at ${answer.root} did not compile: ${entry.error}`,
      };
    }

    return entry?.components === undefined
      ? undefined
      : {
          root: answer.root,
          text: readyText(answer.root, entry.components, entry.ignoredBy),
        };
  }

  if ('none' in answer) {
    return typeof lastRoot === 'string'
      ? {
          root: null,
          text: 'No repository library here; use built-in components only.',
        }
      : undefined;
  }

  return {
    root: null,
    text: `The repository library could not be checked: ${answer.failed}`,
  };
};
