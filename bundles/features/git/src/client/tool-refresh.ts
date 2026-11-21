// Bundle isolation 5(c) (D12): the chat no longer refreshes a Project after a
// tool call, so git asks for it after its own `git` tool finishes.

import type { ThreadUpdateInput } from './api/peers.js';

/** The tool whose finished calls change what git reads. */
const GIT_TOOL = 'git';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The `onThreadUpdateHook` handler: after a finished `git` call in a held
 * Thread, requests that Thread's Project refresh. Any other update is ignored.
 */
export const refreshAfterGit =
  (request: (projectId: string) => void) =>
  (input: ThreadUpdateInput): void => {
    if (input.update.kind !== 'event') return;
    const event = input.update.event.event;
    if (!isRecord(event) || event.type !== 'tool.finished') return;
    const call = event.call;
    if (!isRecord(call) || call.name !== GIT_TOOL) return;
    request(input.projectId);
  };
