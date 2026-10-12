import {
  type CallArg,
  type Disposable,
  disposableSchema,
  ref,
  type StreamListener,
  streamListener,
} from 'bundle/contracts';
import { z } from 'zod';

/*
 * terminal/v1: tracked terminal commands of the calling prompt's Thread
 * (call.scope), derived one to one from the runtime's tool-host TerminalControl, and
 * (1.1.0, stage 10) the terminal sessions of every Project: the manual shells
 * a user opens and the commands the agent runs, with their output stream.
 * The `terminal` bundle provides it; until stage 10's host switch the
 * runtime's provisional provider serves `run` only (`TerminalV1`).
 */

/** A command registered with its owning Thread for its entire lifetime. */
export interface TerminalInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly background?: boolean;
  readonly pty?: boolean;
}

export interface TerminalResult {
  readonly terminalId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly reason: 'exited' | 'timeout' | 'terminated' | 'failed';
}

export interface BackgroundTerminal {
  readonly terminalId: string;
  readonly background: true;
}

export const terminalInputSchema = z
  .object({
    command: z.string(),
    cwd: z.string(),
    timeoutMs: z.number(),
    background: z.boolean().optional(),
    pty: z.boolean().optional(),
  })
  .strict();

export const terminalResultSchema: z.ZodType<TerminalResult, TerminalResult> =
  z.looseObject({
    terminalId: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    durationMs: z.number(),
    reason: z.enum(['exited', 'timeout', 'terminated', 'failed']),
  });

export const backgroundTerminalSchema: z.ZodType<
  BackgroundTerminal,
  BackgroundTerminal
> = z.looseObject({
  terminalId: z.string(),
  background: z.literal(true),
});

export interface Terminal {
  /**
   * Runs one command. A foreground command resolves with its result; a
   * background one resolves at once with its terminal ID.
   */
  run(
    input: TerminalInput,
    call?: CallArg,
  ): Promise<TerminalResult | BackgroundTerminal>;
}

// Sessions (1.1.0) ------------------------------------------------------------

/** One tracked terminal, as `GET /projects/:id/terminals` lists it. */
export interface TerminalSession {
  readonly id: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly origin: 'agent' | 'user';
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly timeoutMs: number | null;
  readonly state: 'starting' | 'running' | 'exited';
  readonly pty: boolean;
}

/** One chunk of a terminal's live output. */
export interface TerminalOutput {
  readonly projectId: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly data: string;
  /** Exclusive UTF-16 offset after this chunk. */
  readonly offset: number;
}

/** A terminal's retained output after a cursor (`GET /terminals/:id`). */
export interface TerminalSnapshot {
  readonly terminal: TerminalSession;
  readonly output: string;
  readonly offset: number;
  /** The cursor is older than the retained output. */
  readonly truncated: boolean;
}

/**
 * One emission of a Project's terminal stream, as the `/projects` Socket.IO
 * namespace emitted it: a snapshot on every subscribe, then updates,
 * removals and live output (never buffered before the snapshot).
 */
export type TerminalWatchItem =
  | {
      readonly kind: 'snapshot';
      readonly projectId: string;
      readonly terminals: readonly TerminalSession[];
    }
  | { readonly kind: 'updated'; readonly terminal: TerminalSession }
  | {
      readonly kind: 'removed';
      readonly projectId: string;
      readonly threadId: string;
      readonly terminalId: string;
    }
  | { readonly kind: 'output'; readonly output: TerminalOutput };

export interface TerminalSize {
  readonly cols?: number;
  readonly rows?: number;
}

export const terminalSessionSchema: z.ZodType<
  TerminalSession,
  TerminalSession
> = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  origin: z.enum(['agent', 'user']),
  command: z.string(),
  cwd: z.string(),
  startedAt: z.string(),
  timeoutMs: z.number().nullable(),
  state: z.enum(['starting', 'running', 'exited']),
  pty: z.boolean(),
});

export const terminalOutputSchema: z.ZodType<TerminalOutput, TerminalOutput> =
  z.looseObject({
    projectId: z.string(),
    threadId: z.string(),
    terminalId: z.string(),
    data: z.string(),
    offset: z.number(),
  });

export const terminalSnapshotSchema: z.ZodType<
  TerminalSnapshot,
  TerminalSnapshot
> = z.looseObject({
  terminal: terminalSessionSchema,
  output: z.string(),
  offset: z.number(),
  truncated: z.boolean(),
});

export const terminalWatchItemSchema: z.ZodType<
  TerminalWatchItem,
  TerminalWatchItem
> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('snapshot'),
      projectId: z.string(),
      terminals: z.array(terminalSessionSchema),
    })
    .strict(),
  z
    .object({ kind: z.literal('updated'), terminal: terminalSessionSchema })
    .strict(),
  z
    .object({
      kind: z.literal('removed'),
      projectId: z.string(),
      threadId: z.string(),
      terminalId: z.string(),
    })
    .strict(),
  z
    .object({ kind: z.literal('output'), output: terminalOutputSchema })
    .strict(),
]);

/** terminal/v1 1.1.0: `run` plus the sessions of every Project. */
export interface TerminalService extends Terminal {
  /** The Project's sessions, in start order. */
  list(projectId: string, call?: CallArg): Promise<readonly TerminalSession[]>;
  /**
   * Opens a manual bash PTY in the Thread's working directory, bringing its
   * Project back first. `undefined` is `terminal_unavailable`: no such
   * Thread, a finished or closing one, or a Project without a sandbox.
   */
  create(
    threadId: string,
    size: TerminalSize,
    call?: CallArg,
  ): Promise<TerminalSession | undefined>;
  /** `undefined` is `terminal_missing`. */
  snapshot(
    terminalId: string,
    after: number,
    call?: CallArg,
  ): Promise<TerminalSnapshot | undefined>;
  /** `false` is `terminal_missing` (no running process). */
  input(terminalId: string, data: string, call?: CallArg): Promise<boolean>;
  /** `false` is `terminal_missing` (no running process). */
  resize(
    terminalId: string,
    cols: number,
    rows: number,
    call?: CallArg,
  ): Promise<boolean>;
  /** Stops and removes the session; `false` when none existed. Idempotent. */
  stop(terminalId: string, call?: CallArg): Promise<boolean>;
  /**
   * The Project's terminal stream: one snapshot on subscribe, then its
   * updates and removals, and live output only after the snapshot.
   */
  watchProject(
    projectId: string,
    listener: StreamListener<TerminalWatchItem>,
    call?: CallArg,
  ): Disposable;
}

const terminalSizeSchema = z
  .object({ cols: z.number().optional(), rows: z.number().optional() })
  .strict();

/** The 1.0.0 method: `run`. */
export const terminalMethods = {
  run: {
    input: terminalInputSchema,
    output: z.union([backgroundTerminalSchema, terminalResultSchema]),
  },
} as const;

/** Every 1.1.0 method. */
export const terminalServiceMethods = {
  ...terminalMethods,
  list: { input: z.string(), output: z.array(terminalSessionSchema) },
  create: {
    input: z.tuple([z.string(), terminalSizeSchema]),
    output: terminalSessionSchema.optional(),
  },
  snapshot: {
    input: z.tuple([z.string(), z.number()]),
    output: terminalSnapshotSchema.optional(),
  },
  input: { input: z.tuple([z.string(), z.string()]), output: z.boolean() },
  resize: {
    input: z.tuple([z.string(), z.number(), z.number()]),
    output: z.boolean(),
  },
  stop: { input: z.string(), output: z.boolean() },
  watchProject: {
    input: z.tuple([z.string(), streamListener(terminalWatchItemSchema)]),
    output: disposableSchema,
  },
} as const;

/** terminal/v1 as its 1.0.0 consumers and providers see it: `run` only. */
export const TerminalV1 = ref<Terminal>('terminal/v1');

/** terminal/v1 1.1.0, as the `terminal` bundle provides it. */
export const TerminalServiceV1 = ref<TerminalService>('terminal/v1');
