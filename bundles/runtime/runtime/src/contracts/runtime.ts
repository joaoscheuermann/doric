import {
  type CallArg,
  type Disposable,
  disposableSchema,
  functionSchema,
  noInput,
  ref,
  type StreamListener,
} from 'bundle/contracts';
import type { SandboxSshAccess } from 'sandbox';
import { z } from 'zod';

import {
  type DeleteResult,
  deleteResultSchema,
  type Page,
  type Project,
  type ProjectColor,
  projectColorSchema,
  projectPageSchema,
  projectSchema,
  sandboxSshAccessSchema,
  type Terminal,
  type TerminalOutput,
  type Thread,
  type ThreadEvent,
} from './model.js';
import {
  type ProjectWatchInput,
  type ProjectWatchItem,
  watchMethods,
} from './watches.js';

/*
 * runtime/v1: Projects, boot recovery, host stop and the live notices of the
 * workspace (design 57 §2.2). API mínima: one method per WorkspaceService
 * operation the transport and the kernel call today.
 */

/** The key of the codec marker in generated schemas (`bundle/runtime`). */
export const LOCAL_KEY = 'x-doric-local';

export interface RecoverySummary {
  /** Threads `threads.reconcile()` moved back to ready. */
  readonly interruptedThreads: number;
  /** Projects `projects.reconcile()` moved back to queued. */
  readonly interruptedProjects: number;
  /** Prompts `resumeInterrupted()` re-enqueued. */
  readonly resumedPrompts: number;
}

/** One WorkspacePublisher callback, in publication order, after its commit. */
export type RuntimeNotice =
  | { readonly kind: 'event'; readonly value: ThreadEvent }
  | { readonly kind: 'threadUpdated'; readonly value: Thread }
  | {
      readonly kind: 'threadDeleted';
      readonly projectId: string;
      readonly threadId: string;
    }
  | { readonly kind: 'projectUpdated'; readonly value: Project }
  | { readonly kind: 'projectDeleted'; readonly projectId: string }
  | { readonly kind: 'terminalUpdated'; readonly value: Terminal }
  | { readonly kind: 'terminalOutput'; readonly value: TerminalOutput }
  | {
      readonly kind: 'terminalRemoved';
      readonly projectId: string;
      readonly threadId: string;
      readonly terminalId: string;
    };

export type RuntimeListener = (notice: RuntimeNotice) => void;

/**
 * One runtime process (57-WP-H): its bundle generation and the incarnation of
 * that generation's process, as `doric.generation/v1.describe()` answers.
 */
export interface RuntimeOwner {
  readonly generation: number;
  readonly incarnation: number;
}

/**
 * The generation handover input (57-WP-H, cross-review G-1): the other
 * runtime processes that are still alive. A Project owned by one of them is
 * left to it (standby); one owned by a process not listed is reconciled as
 * after a host restart.
 */
export interface Handover {
  readonly live: readonly RuntimeOwner[];
}

/** Called by a draining runtime once it let one Project go. */
export type ReleasedListener = (projectId: string) => void;

export interface VmSsh {
  readonly projectId: string;
  readonly ssh: SandboxSshAccess;
}

/** A Project ordered by its own or its Threads' latest activity. */
export interface ProjectActivity {
  readonly project: Project;
  readonly activityAt: string;
  readonly latestActiveThreadId?: string;
}

export const projectActivitySchema: z.ZodType<
  ProjectActivity,
  ProjectActivity
> = z.looseObject({
  project: projectSchema,
  activityAt: z.string(),
  latestActiveThreadId: z.string().optional(),
});

/** The structural runtime: Projects, boot recovery, host stop and notices. */
export interface Runtime {
  /**
   * Once per runtime process (kernel, at boot and after each respawn):
   * threads.reconcile, projects.reconcile, resumeInterrupted and
   * recoverProjects, in that order.
   */
  recover(call?: CallArg): Promise<RecoverySummary>;
  /**
   * `recover` for a process that starts while other runtime processes are
   * alive (57-WP-H): the Projects a process in `handover.live` owns are left
   * to it (standby). One recovery per process: whichever of the two runs
   * first answers both.
   */
  recoverWith(handover: Handover, call?: CallArg): Promise<RecoverySummary>;
  /**
   * Takes up the Projects left in standby whose owner let them go or is no
   * longer in `handover.live` (kernel, after each release or loss).
   */
  adopt(handover: Handover, call?: CallArg): Promise<void>;
  /**
   * The runtime of a replaced generation (kernel): no Project comes alive
   * here any more; each live Project lets its running prompts finish, closes
   * its terminals, releases its sandbox lease and its owner, then `released`
   * is called with its id. Resolves once every Project is released.
   */
  drain(released: ReleasedListener, call?: CallArg): Promise<void>;
  /** Host stop (kernel): today's WorkspaceService.dispose; idempotent. */
  dispose(call?: CallArg): Promise<void>;
  /** Rejects with a plain `Error('Doric is shutting down.')` after dispose. */
  createProject(
    input: { readonly name: string },
    call?: CallArg,
  ): Promise<Project>;
  project(id: string, call?: CallArg): Promise<Project | undefined>;
  projects(
    page: { readonly limit: number; readonly cursor?: string },
    call?: CallArg,
  ): Promise<Page<Project>>;
  projectActivity(call?: CallArg): Promise<readonly ProjectActivity[]>;
  renameProject(
    input: { readonly id: string; readonly name: string },
    call?: CallArg,
  ): Promise<Project | undefined>;
  /** `color: null` clears the color, leaving the field absent. */
  setProjectColor(
    input: { readonly id: string; readonly color: ProjectColor | null },
    call?: CallArg,
  ): Promise<Project | undefined>;
  terminateProject(id: string, call?: CallArg): Promise<Project | undefined>;
  deleteProject(id: string, call?: CallArg): Promise<DeleteResult>;
  /** service.sshForVm. */
  vmSsh(vmId: string, call?: CallArg): Promise<VmSsh | undefined>;
  /** Every notice, in publication order, after its commit. */
  watch(listener: RuntimeListener, call?: CallArg): Disposable;
  /**
   * The `/projects` namespace as a stream (stage 9 R-STREAM, 1.2.0): one
   * snapshot of the Project, its Threads and terminals, then its Project and
   * Thread notices. Remote-callable; the desktop bridge subscribes to it.
   */
  watchProject(
    input: ProjectWatchInput,
    listener: StreamListener<ProjectWatchItem>,
    call?: CallArg,
  ): Disposable;
}

const optional = <T extends z.ZodType>(schema: T) => schema.optional();

export const recoverySummarySchema: z.ZodType<
  RecoverySummary,
  RecoverySummary
> = z.looseObject({
  interruptedThreads: z.number(),
  interruptedProjects: z.number(),
  resumedPrompts: z.number(),
});

export const vmSshSchema: z.ZodType<VmSsh, VmSsh> = z.looseObject({
  projectId: z.string(),
  ssh: sandboxSshAccessSchema,
});

export const runtimeListenerSchema = functionSchema<RuntimeListener>().meta({
  [LOCAL_KEY]: 'callback',
});

export const runtimeOwnerSchema: z.ZodType<RuntimeOwner, RuntimeOwner> = z
  .object({ generation: z.number().int(), incarnation: z.number().int() })
  .strict();

export const handoverSchema: z.ZodType<Handover, Handover> = z
  .object({ live: z.array(runtimeOwnerSchema) })
  .strict();

export const releasedListenerSchema = functionSchema<ReleasedListener>().meta({
  [LOCAL_KEY]: 'callback',
});

export const runtimeMethods = {
  recover: { input: noInput, output: recoverySummarySchema },
  recoverWith: { input: handoverSchema, output: recoverySummarySchema },
  adopt: { input: handoverSchema, output: z.void() },
  drain: { input: releasedListenerSchema, output: z.void() },
  dispose: { input: noInput, output: z.void() },
  createProject: {
    input: z.object({ name: z.string() }).strict(),
    output: projectSchema,
  },
  project: { input: z.string(), output: optional(projectSchema) },
  projects: {
    input: z
      .object({ limit: z.number(), cursor: z.string().optional() })
      .strict(),
    output: projectPageSchema,
  },
  projectActivity: { input: noInput, output: z.array(projectActivitySchema) },
  renameProject: {
    input: z.object({ id: z.string(), name: z.string() }).strict(),
    output: optional(projectSchema),
  },
  setProjectColor: {
    input: z
      .object({ id: z.string(), color: projectColorSchema.nullable() })
      .strict(),
    output: optional(projectSchema),
  },
  terminateProject: { input: z.string(), output: optional(projectSchema) },
  deleteProject: { input: z.string(), output: deleteResultSchema },
  vmSsh: { input: z.string(), output: optional(vmSshSchema) },
  watch: { input: runtimeListenerSchema, output: disposableSchema },
  watchProject: watchMethods.project,
} as const;

export const RuntimeV1 = ref<Runtime>('runtime/v1');
