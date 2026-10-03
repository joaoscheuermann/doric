import type {
  CatalogModel,
  ConfigurationInput,
  Credential,
  CredentialCreate,
  CredentialUpdate,
  DoricConfiguration,
  ProviderKind,
  ProviderValuesRef,
  ToolCatalogEntry,
} from './config';
import type { ConnectionApi } from './connection';
import type { ThreadGit } from './thread-git';

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
  /** The prompt the Thread is running, present only while one is. */
  readonly activePromptId?: string;
  /** The Thread's working directory, absolute inside the sandbox. */
  readonly cwd: string;
  /**
   * The repository the cwd root is, as the host read it from the disk alone:
   * `'github'` only when the `origin` remote is on github.com. Absent when the
   * root holds no `.git` entry.
   */
  readonly cwdRepo?: 'git' | 'github';
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
  /**
   * A stream failure, named for the Thread whose watch raised it, so a surface
   * draws it in that Thread's conversation and in no other.
   */
  | {
      readonly kind: 'error';
      readonly threadId: string;
      readonly message: string;
    };

/**
 * The app's best-effort local snapshot of one Thread's durable log: its
 * record, the events held, and the sequence a subscription resumes from. A
 * `null` answer means the app holds none, never that the Thread is empty.
 */
export type ThreadHistory = {
  readonly thread: Thread | null;
  readonly lastSequence: number;
  readonly events: readonly ThreadEvent[];
};

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
   * The settings surface is its own window; `open` shows it, or focuses the one
   * already open rather than duplicating it.
   */
  readonly settings: {
    /** Shows the settings window, or focuses the one already open. */
    open(): Promise<void>;
    /**
     * Settles a change still waiting on the save debounce, which is what the
     * main process's held-back close is waiting for. Returns its own
     * unsubscribe.
     */
    onFlush(listener: () => void | Promise<void>): () => void;
  };
  /**
   * The configuration the host owns, shared by every Project. `get` reads it —
   * never with a stored GitHub token, only whether one exists — and `update`
   * writes it whole, returning the revision the host stored.
   */
  readonly config: {
    get(): Promise<DoricConfiguration>;
    update(configuration: ConfigurationInput): Promise<DoricConfiguration>;
  };
  /**
   * The host's credential store. The secret never crosses this boundary in
   * either direction: a create or patch sends one, and every answer is the
   * public view, where `hasSecret` stands in for the value.
   */
  readonly credentials: {
    list(): Promise<readonly Credential[]>;
    create(input: CredentialCreate): Promise<Credential>;
    update(id: string, input: CredentialUpdate): Promise<Credential>;
    remove(id: string): Promise<void>;
  };
  /**
   * The host's tool catalog: the tools the loaded bundles expose, and the
   * configuration fields each one declares. The host owns it, so the surface
   * draws the tools it actually has and lets each tool describe its own section.
   */
  readonly tools: {
    catalog(): Promise<readonly ToolCatalogEntry[]>;
  };
  /**
   * The host's provider catalog: what kinds of provider exist, which fields each
   * declares, which per-provider lists it keeps, and what one provider's own
   * model catalog describes. The host owns these, so the renderer draws whatever
   * it is answered with rather than a fixed list — and the read happens on the
   * host's side, because this window never opens HTTP.
   */
  readonly providers: {
    kinds(): Promise<readonly ProviderKind[]>;
    models(values: ProviderValuesRef): Promise<readonly CatalogModel[]>;
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
    /**
     * The whole sandbox tree in one read, with each directory's children nested.
     * The file tree surface draws from this, so opening it reads the workspace
     * once rather than one directory per expansion; a file's content is still
     * read on demand, through `file`.
     */
    tree(projectId: string, path?: string): Promise<ProjectTreeResult>;
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
    /**
     * The git summary of one Thread's working directory, read from the disk:
     * whether the cwd root is a repository, and if so every fact the footer and
     * its popover state about it.
     */
    git(id: string): Promise<ThreadGit>;
    /**
     * Moves a Thread's working directory, returning the Thread as the host
     * stored it. A path the host refuses is a rejection carrying the reason.
     */
    setCwd(id: string, cwd: string): Promise<Thread>;
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
    /** Stops the prompt a Thread is running, leaving its queue alone. */
    interrupt(id: string, promptId: string): Promise<void>;
    /**
     * Takes up a prompt an interruption left unfinished, returning the Thread as
     * the host stored it. A prompt the host owes no run is refused with the
     * reason.
     */
    resume(id: string, promptId: string): Promise<Thread>;
    /**
     * The local snapshot of one Thread's durable log the main process kept,
     * or `null` when the app holds none. A conversation opens from it
     * instantly and reconciles with the stream afterwards.
     */
    history(id: string): Promise<ThreadHistory | null>;
    /**
     * Follows one Thread's updates. Several watches coexist, one per Thread the
     * surface holds open, and each carries only its own Thread's updates: a
     * `snapshot`, `event` or `updated` names the Thread it belongs to, a
     * `deleted` names the Thread it dropped, and an `error` belongs to the watch
     * that delivered it. The returned function releases only this Thread's watch
     * and is safe to call twice, or after a newer watch for the same Thread.
     */
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

/** One tree node: a file, or a directory that carries its own children. */
export type ProjectTreeNode = ProjectFileEntry & {
  /** Present for directories; empty when every child is hidden or ignored. */
  readonly children?: readonly ProjectTreeNode[];
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

export type ProjectChangeSet = {
  readonly path: string;
  readonly diff: string;
  readonly changes: readonly ProjectChange[];
};

/** Every Git repository in the sandbox: one entry per repository. */
export type ProjectDiff = {
  readonly path?: string;
  readonly repositories: readonly ProjectChangeSet[];
};

export type ProjectFilesResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectFileEntry[];
    }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

/** The whole sandbox tree in one read, with each directory's children nested. */
export type ProjectTreeResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectTreeNode[];
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
