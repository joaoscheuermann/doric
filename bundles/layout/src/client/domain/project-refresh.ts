import type { Thread } from './workspace.js';

/**
 * The fields of a terminal the Project refresh signal reads. The terminal
 * record itself belongs to the provisional terminals feature; the signal names
 * only what it compares.
 */
export type ActivityTerminal = {
  readonly id: string;
  readonly state: string;
  readonly command: string;
  readonly cwd: string;
};

/** A stable signal excludes terminal output and metadata unrelated to sandbox contents. */
export const projectActivity = <Terminal extends ActivityTerminal>(
  threads: readonly Thread[],
  terminals: readonly Terminal[],
): string =>
  JSON.stringify([
    threads.map(({ id, state, cwd }) => [id, state, cwd]),
    terminals.map(({ id, state, command, cwd }) => [id, state, command, cwd]),
  ]);
