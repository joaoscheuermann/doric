import { sandboxWrites } from './projector';
import type { Terminal } from './terminals';
import type { ThreadChats } from './thread-chats';
import type { Thread } from './workspace';

/** Projects changed by newly observed tool completions or Thread lifecycle changes. */
export function changedSandboxProjects(
  previous: ThreadChats,
  next: ThreadChats,
): ReadonlySet<string> {
  const projects = new Set<string>();
  for (const [id, chat] of next.chats) {
    const before = previous.chats.get(id);
    if (
      !before ||
      before.thread.cwd !== chat.thread.cwd ||
      before.thread.state !== chat.thread.state
    ) {
      projects.add(chat.thread.projectId);
      continue;
    }
    if (before.projection === chat.projection) continue;
    const sequence = before.projection.events.at(-1)?.sequence ?? 0;
    const events = chat.projection.events;
    let start = events.length;
    while (start > 0 && events[start - 1].sequence > sequence) start--;
    if (sandboxWrites(events.slice(start)) > 0)
      projects.add(chat.thread.projectId);
  }
  return projects;
}

/** A stable signal excludes terminal output and metadata unrelated to sandbox contents. */
export const projectActivity = (
  threads: readonly Thread[],
  terminals: readonly Terminal[],
): string =>
  JSON.stringify([
    threads.map(({ id, state, cwd }) => [id, state, cwd]),
    terminals.map(({ id, state, command, cwd }) => [id, state, command, cwd]),
  ]);
