// Bundle isolation 5(c) (D12): the chat no longer refreshes a Project after a
// tool call, so `files` asks for it after its own `edit` and `write` calls.

import type { ThreadUpdateInput } from '../api/peers.js';

/** The `files` tools whose finished calls write the sandbox. */
const WRITING_TOOLS: ReadonlySet<string> = new Set(['edit', 'write']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The `onThreadUpdateHook` handler: after a finished `edit` or `write` call in
 * a held Thread, requests that Thread's Project refresh. Any other update,
 * tool or call state is ignored.
 */
export const refreshAfterWrites =
  (request: (projectId: string) => void) =>
  (input: ThreadUpdateInput): void => {
    if (input.update.kind !== 'event') return;
    const event: unknown = input.update.event.event;
    if (!isRecord(event) || event.type !== 'tool.finished') return;
    const call = event.call;
    if (!isRecord(call) || typeof call.name !== 'string') return;
    if (WRITING_TOOLS.has(call.name)) request(input.projectId);
  };
