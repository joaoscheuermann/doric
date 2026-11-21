/**
 * Reading a `thread-spawn` tool call's serialized input and output into the
 * fields a spawn block renders: the prompt the agent handed down, the title it
 * gave the child, the agent, model and effort the child runs with, and the
 * Thread that child turned out to be.
 *
 * Both strings come from the log, so malformed JSON or an unexpected shape
 * falls back to whatever raw text is present rather than throwing: a prompt that
 * cannot be read from the args is the args themselves, and a result that names
 * no whole child spawns nothing the transcript could link to.
 */

import type { SpawnedThread } from 'runtime/contracts';

export const THREAD_SPAWN_TOOL = 'thread-spawn';

export type SpawnedChild = SpawnedThread;

export type ParsedThreadSpawn = {
  /** `args.prompt`; the raw args text when they do not parse. */
  readonly prompt: string;
  /** The title the call gave the child, when it gave a non-empty one. */
  readonly title?: string;
  /** `args.agent`, trimmed, when it is a non-empty string. */
  readonly agent?: string;
  /** `args.model`, trimmed, when it is a non-empty string. */
  readonly model?: string;
  /** `args.effort`, trimmed, when it is a non-empty string. */
  readonly effort?: string;
  /** The child the call spawned, only when the result names both ids. */
  readonly child?: SpawnedChild;
};

/** The text as an object, or nothing when it is not JSON or not one. */
const parseJsonRecord = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The text at `key`, trimmed; nothing when it is empty or not a string. */
const readText = (
  input: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = input?.[key];
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length === 0 ? undefined : text;
};

/** The ids a finished spawn result names, when it names both of them. */
const readChild = (
  output: Record<string, unknown> | undefined,
): SpawnedChild | undefined => {
  const { threadId, promptId } = output ?? {};
  if (typeof threadId !== 'string' || typeof promptId !== 'string') {
    return undefined;
  }
  return threadId.length > 0 && promptId.length > 0
    ? { threadId, promptId }
    : undefined;
};

/** Parses a `thread-spawn` tool call's `args` and `result` JSON strings. */
export const parseThreadSpawn = (
  args: string,
  result?: string,
): ParsedThreadSpawn => {
  const input = parseJsonRecord(args);

  return {
    prompt: typeof input?.prompt === 'string' ? input.prompt : args,
    title: readText(input, 'title'),
    agent: readText(input, 'agent'),
    model: readText(input, 'model'),
    effort: readText(input, 'effort'),
    child:
      result === undefined ? undefined : readChild(parseJsonRecord(result)),
  };
};
