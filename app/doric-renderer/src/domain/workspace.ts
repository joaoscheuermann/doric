import type { ConfigurationInput, DoricConfiguration } from './config';
import type { ConnectionApi } from './connection';

/**
 * The colors a Project can be marked with. The vocabulary is the host's; this
 * module also says how each one paints, so no surface invents a color name and
 * an unassigned Project stays absent rather than falling back to a default.
 */
export const projectColors = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;

export type ProjectColor = (typeof projectColors)[number];

/** The fill each palette color gives the Project's mark. */
export const projectColorSwatch: Record<ProjectColor, string> = {
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  green: 'bg-green-500',
  teal: 'bg-teal-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
};

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly color?: ProjectColor;
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

export type ThreadEvent = {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
};

export type ThreadUpdate =
  | {
      readonly kind: 'snapshot';
      readonly snapshot: {
        readonly threadId: string;
        readonly projectId: string | null;
        readonly project: Project | null;
        readonly thread: Thread | null;
        readonly events: readonly ThreadEvent[];
      };
    }
  | { readonly kind: 'event'; readonly event: ThreadEvent }
  | { readonly kind: 'updated'; readonly thread: Thread }
  | {
      readonly kind: 'deleted';
      readonly projectId: string;
      readonly threadId: string;
    }
  | { readonly kind: 'error'; readonly message: string };

export type ProjectUpdate =
  | {
      readonly kind: 'snapshot';
      readonly snapshot: {
        readonly projectId: string;
        readonly project: Project | null;
        readonly threads: readonly Thread[];
      };
    }
  | { readonly kind: 'thread-updated'; readonly thread: Thread }
  | {
      readonly kind: 'thread-deleted';
      readonly projectId: string;
      readonly threadId: string;
    }
  | { readonly kind: 'project-updated'; readonly project: Project }
  | { readonly kind: 'project-deleted'; readonly projectId: string }
  | { readonly kind: 'error'; readonly message: string };

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
  readonly connection: ConnectionApi;
  /**
   * The configuration the host owns, shared by every Project. `get` reads it —
   * never with a stored GitHub token, only whether one exists — and `update`
   * writes it whole, returning the revision the host stored.
   */
  readonly config: {
    get(): Promise<DoricConfiguration>;
    update(configuration: ConfigurationInput): Promise<DoricConfiguration>;
  };
  readonly projects: {
    list(): Promise<readonly Project[]>;
    create(name: string): Promise<Project>;
    rename(id: string, name: string): Promise<Project>;
    /** Assigns a palette color, or clears it when none is named. */
    setColor(id: string, color?: ProjectColor): Promise<Project>;
    terminate(id: string): Promise<Project>;
    delete(id: string): Promise<void>;
    /** A directory of the Project's sandbox; `''` is the workspace root. */
    files(projectId: string, path?: string): Promise<ProjectFilesResult>;
    /** One file of the Project's sandbox, which the host may cut short. */
    file(projectId: string, path: string): Promise<ProjectFileResult>;
    /** The sandbox's diff against git, or the diff of one path inside it. */
    diff(projectId: string, path?: string): Promise<ProjectDiffResult>;
    watch(
      projectId: string,
      listener: (update: ProjectUpdate) => void,
    ): () => void;
  };
  readonly threads: {
    list(projectId: string): Promise<readonly Thread[]>;
    get(id: string): Promise<Thread | undefined>;
    create(
      projectId: string,
      name: string,
      parentThreadId?: string,
    ): Promise<Thread>;
    rename(id: string, name: string): Promise<Thread>;
    prompt(id: string, prompt: string): Promise<{ readonly promptId: string }>;
    rewind(
      id: string,
      promptId: string,
      prompt: string,
    ): Promise<{ readonly promptId: string }>;
    watch(
      id: string,
      afterSequence: number,
      listener: (update: ThreadUpdate) => void,
    ): () => void;
    terminate(id: string): Promise<Thread>;
    delete(id: string): Promise<void>;
  };
};

/**
 * Why a Project's sandbox cannot be read. Each state is one the surface
 * explains, so none of them is a thrown failure.
 */
export type ProjectLeaseState =
  | 'missing'
  | 'pending'
  | 'expired'
  | 'unavailable';

/**
 * The sandbox vocabulary: a directory's entries, one file's content, and the
 * workspace diff a Project's Threads share. Every path is relative to the
 * workspace root, which is the empty path.
 */
export type ProjectFileEntry = {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly size?: number;
};

export type ProjectFileContent = {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly binary: boolean;
};

export type ProjectChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export type ProjectChange = {
  readonly path: string;
  readonly status: ProjectChangeStatus;
};

export type ProjectDiff = {
  readonly path?: string;
  readonly repository: boolean;
  readonly diff: string;
  readonly changes: readonly ProjectChange[];
};

export type ProjectFilesResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectFileEntry[];
    }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

export type ProjectFileResult =
  | { readonly status: 'ready'; readonly file: ProjectFileContent }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

export type ProjectDiffResult =
  | { readonly status: 'ready'; readonly diff: ProjectDiff }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

export const threadsForProject = (
  threads: readonly Thread[],
  projectId: string,
): readonly Thread[] =>
  threads.filter((thread) => thread.projectId === projectId);

export const upsert = <Value extends { readonly id: string }>(
  values: readonly Value[],
  value: Value,
  position: 'first' | 'last' = 'first',
): readonly Value[] => {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index === -1) {
    return position === 'last' ? [...values, value] : [value, ...values];
  }
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
