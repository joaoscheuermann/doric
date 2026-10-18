/** The conversation's route (decision "Rotas"), a child of `/`. */
export const THREAD_ROUTE = '/projects/:projectId/threads/:threadId';

/** The path of one Thread's conversation. */
export const threadPath = (projectId: string, threadId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;

/** The Thread a route match names, when it is the conversation's route. */
export const routeThread = (
  match:
    | {
        readonly pattern: string;
        readonly params: Readonly<Record<string, string>>;
      }
    | undefined,
): { readonly projectId: string; readonly threadId: string } | undefined => {
  if (match?.pattern !== THREAD_ROUTE) return undefined;
  const { projectId, threadId } = match.params;
  return projectId === undefined || threadId === undefined
    ? undefined
    : { projectId, threadId };
};
