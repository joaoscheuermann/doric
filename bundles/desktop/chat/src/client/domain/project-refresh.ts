import type { ThreadChats } from './thread-chats.js';

/**
 * Projects changed by Thread lifecycle changes: a Thread the store starts to
 * hold, a held Thread whose working directory changes, or one whose state
 * changes. A Thread that starts running (a prompt starting) changes nothing in
 * the sandbox yet, and a refresh then would compete with the prompt for the
 * host and the sandbox, so only its other state changes count: the prompt
 * finishing, or failing, still refreshes the Project. A finished tool call
 * counts for nothing: the bundle that owns the tool asks for its refresh.
 */
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
      (before.thread.state !== chat.thread.state &&
        chat.thread.state !== 'running')
    )
      projects.add(chat.thread.projectId);
  }
  return projects;
}
