// The live terminal behind a `terminal` call in the chat (bundle isolation
// 5(b), change 4; moved from the chat's `stores/live-terminals.ts`): which of
// the store's terminals a call's block follows, and how much of its output
// the block keeps.

import type { Terminal } from './terminals.js';

/** The characters of live output a call's block keeps, from the end. */
export const LIVE_OUTPUT_LIMIT = 32_000;

/** `output` with `chunk` appended, keeping the last {@link LIVE_OUTPUT_LIMIT} characters. */
export const appendCapped = (output: string, chunk: string): string => {
  const next = `${output}${chunk}`;
  return next.length > LIVE_OUTPUT_LIMIT
    ? next.slice(-LIVE_OUTPUT_LIMIT)
    : next;
};

/** Whether `left` started after `right`, the later of the list on a tie. */
const startedLater = (left: Terminal, right: Terminal): boolean =>
  Date.parse(left.startedAt) >= Date.parse(right.startedAt);

/**
 * The terminal a `terminal` call's block follows, or `undefined`:
 * - the one `terminalId` names, when the call's result names one, whatever
 *   its Thread or state; none when the list does not hold it;
 * - otherwise, only while the call runs, an agent's terminal on `threadId`
 *   running `command` (any command when none is given): the newest one that
 *   has not exited, else the newest one.
 */
export const matchLiveTerminal = (
  terminals: readonly Terminal[],
  input: {
    readonly threadId: string;
    readonly command?: string;
    readonly terminalId?: string;
    readonly toolRunning: boolean;
  },
): Terminal | undefined => {
  if (input.terminalId !== undefined)
    return terminals.find((terminal) => terminal.id === input.terminalId);
  if (!input.toolRunning) return undefined;
  let newestActive: Terminal | undefined;
  let newest: Terminal | undefined;
  for (const terminal of terminals) {
    if (terminal.origin !== 'agent' || terminal.threadId !== input.threadId)
      continue;
    if (input.command !== undefined && terminal.command !== input.command)
      continue;
    if (newest === undefined || startedLater(terminal, newest))
      newest = terminal;
    if (
      terminal.state !== 'exited' &&
      (newestActive === undefined || startedLater(terminal, newestActive))
    )
      newestActive = terminal;
  }
  return newestActive ?? newest;
};
