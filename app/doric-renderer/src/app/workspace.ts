export type Project = {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type Thread = {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type Draft =
  | { readonly kind: 'project' }
  | {
      readonly kind: 'thread';
      readonly projectId: string;
      readonly parentThreadId?: string;
    };

export type Entity =
  | { readonly kind: 'project'; readonly value: Project }
  | { readonly kind: 'thread'; readonly value: Thread };

export type WorkspaceApi = {
  readonly projects: {
    list(): Promise<readonly Project[]>;
    create(name: string): Promise<Project>;
    rename(id: string, name: string): Promise<Project>;
    terminate(id: string): Promise<Project>;
    delete(id: string): Promise<void>;
  };
  readonly threads: {
    list(projectId: string): Promise<readonly Thread[]>;
    create(
      projectId: string,
      name: string,
      parentThreadId?: string,
    ): Promise<Thread>;
    rename(id: string, name: string): Promise<Thread>;
    terminate(id: string): Promise<Thread>;
    delete(id: string): Promise<void>;
  };
};

export const threadsForProject = (
  threads: readonly Thread[],
  projectId: string,
): readonly Thread[] =>
  threads.filter((thread) => thread.projectId === projectId);

export const upsert = <Value extends { readonly id: string }>(
  values: readonly Value[],
  value: Value,
): readonly Value[] => {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index === -1) return [value, ...values];
  return values.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate,
  );
};

export const threadSubtreeIds = (
  threads: readonly Thread[],
  rootId: string,
): ReadonlySet<string> => {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of threads) {
      if (
        thread.parentThreadId !== undefined &&
        ids.has(thread.parentThreadId) &&
        !ids.has(thread.id)
      ) {
        ids.add(thread.id);
        changed = true;
      }
    }
  }
  return ids;
};

export const withoutThreadSubtree = (
  threads: readonly Thread[],
  rootId: string,
): readonly Thread[] => {
  const ids = threadSubtreeIds(threads, rootId);
  return threads.filter((thread) => !ids.has(thread.id));
};

export const limitName = (value: string): string =>
  Array.from(value).slice(0, 80).join('');

export const nameError = (value: string): string | undefined => {
  if (value.includes('\0')) return 'Names cannot contain a null character.';
  const length = Array.from(value.trim()).length;
  if (length === 0 || length > 80) {
    return 'Enter a name between 1 and 80 characters.';
  }
  return undefined;
};

export const messageFrom = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The operation could not be completed.';
