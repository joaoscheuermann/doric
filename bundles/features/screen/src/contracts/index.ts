import {
  type CallArg,
  type Disposable,
  disposableSchema,
  type MethodSpecs,
  noInput,
  ref,
  type StreamListener,
  streamListener,
} from 'bundle/contracts';
import { z } from 'zod';

/*
 * screen.sessions/v2: the HTML5 screen of a Project's sandbox — an xpra
 * server on an internal display, served to the app through the relay the
 * `screen-relay` bundle mounts on the host's own origin.
 *
 * The call is Project-scoped: every Thread of a Project shares the Project's
 * one sandbox, and therefore its one screen. `attach` is an idempotent
 * ensure: it starts the session when the sandbox has none, reuses a live one,
 * and answers where the screen may reach it. It never acquires a lease, so a
 * Project whose sandbox is not up answers `pending` or `unavailable` the way
 * the other lease reads do.
 *
 * 2.0.0 replaces the ready payload's absolute loopback `url` with a
 * host-relative `path` (major: a replaced field). The host cannot know its own
 * public origin behind a reverse proxy or TLS, and the app must reach the
 * screen on the origin it already reaches the host on — including when the
 * host runs on a remote server and the app on a different machine. So the
 * host answers `/screen/<token>/` and the client composes it with the origin
 * it reaches the host on.
 */

/** Why a Project's screen cannot be served right now. */
export type ScreenUnavailableReason =
  | 'sandbox'
  | 'missing-xpra'
  | 'start-failed';

/**
 * The answer of `attach`:
 *
 * - `ready`: the host-relative `path` the window loads — `/screen/<token>/`,
 *   resolved by the client against the origin it reaches the host on — and
 *   the X display the session runs on (`:100` and up), so a reader can point
 *   a GUI app at it.
 * - `pending`: the Project has no sandbox lease yet; retry.
 * - `unavailable`: the sandbox is gone or closing, its image has no `xpra`,
 *   or the session could not be started.
 */
export type ScreenAttach =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly display: string;
    }
  | { readonly status: 'pending' }
  | {
      readonly status: 'unavailable';
      readonly reason: ScreenUnavailableReason;
    };

export const screenUnavailableReasonSchema = z.enum([
  'sandbox',
  'missing-xpra',
  'start-failed',
]);

export const screenAttachSchema: z.ZodType<ScreenAttach, ScreenAttach> =
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('ready'),
        path: z.string().startsWith('/'),
        display: z.string(),
      })
      .strict(),
    z.object({ status: z.literal('pending') }).strict(),
    z
      .object({
        status: z.literal('unavailable'),
        reason: screenUnavailableReasonSchema,
      })
      .strict(),
  ]);

export interface ScreenSessions {
  /**
   * Ensures the Project's screen session and answers the host-relative path
   * the window loads. Idempotent; safe to call whenever the screen opens or a
   * session is believed lost.
   */
  attach(projectId: string, call?: CallArg): Promise<ScreenAttach>;
}

export const screenSessionsMethods = {
  attach: { input: z.string(), output: screenAttachSchema },
} as const;

/** screen.sessions/v2, as the `screen` bundle provides it. */
export const ScreenSessionsV2 = ref<ScreenSessions>('screen.sessions/v2');

/*
 * screen.views/v1: the reader's own views of Project screens, owned by the
 * bundle's desktopMain part.
 *
 * A view is something the reader spawns from the window's sidebar: an id, a
 * label and the `projectId` it watches. The desktop part keeps the list (and
 * its own cache file), maps every `screen.sessions/v2` answer to the view's
 * status, opens one window per view through the platform and heals a window
 * whose screen moved.
 *
 * The host call itself cannot be made from desktopMain: a generation only
 * reaches the providers of its own environment and the kernel's `doric.*`
 * services, so a host bundle contract has no route there. The window is the
 * only side with a bridge to the host, so the desktop part asks it to dial
 * (`attachments`) and the window hands the raw answer back (`deliver`). The
 * mapping from that answer to a status stays here.
 */

/** What one view reads as; the four states a sidebar row shows. */
export type ScreenViewStatus =
  | { readonly kind: 'waiting' }
  | {
      readonly kind: 'ready';
      readonly path: string;
      readonly display: string;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: ScreenUnavailableReason;
    }
  | { readonly kind: 'failed' };

/** One view, as the window reads it. */
export interface ScreenView {
  readonly id: string;
  readonly label: string;
  /** The Project whose screen the view watches. */
  readonly projectId: string;
  readonly status: ScreenViewStatus;
}

/**
 * A dial the desktop part asks the window to make: the window calls
 * `screen.sessions/v2.attach(projectId)` and hands the answer back with the
 * same `seq`, so an answer to a dial that was replaced is never applied.
 */
export interface ScreenAttachRequest {
  readonly viewId: string;
  readonly projectId: string;
  /** The desktop part's dial sequence; monotonic across every view. */
  readonly seq: number;
}

/** The answer of one dial: the host's answer, or `null` when it was unreachable. */
export interface ScreenAttachReport {
  readonly viewId: string;
  readonly seq: number;
  readonly answer: ScreenAttach | null;
}

/**
 * What the window reads: every view with its status, and the dials still
 * awaiting an answer. The revision bumps on every change, which is what a
 * window passes back to `watch` — a window that already holds this revision is
 * up to date and is not sent the same state twice.
 */
export interface ScreenViewsState {
  readonly revision: number;
  readonly views: readonly ScreenView[];
  readonly dials: readonly ScreenAttachRequest[];
}

export const screenViewStatusSchema: z.ZodType<
  ScreenViewStatus,
  ScreenViewStatus
> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('waiting') }).strict(),
  z
    .object({
      kind: z.literal('ready'),
      path: z.string().startsWith('/'),
      display: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      reason: screenUnavailableReasonSchema,
    })
    .strict(),
  z.object({ kind: z.literal('failed') }).strict(),
]);

export const screenViewSchema: z.ZodType<ScreenView, ScreenView> = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    projectId: z.string().min(1),
    status: screenViewStatusSchema,
  })
  .strict();

/** The list as a stream carries it: the reader never mutates what it reads. */
export const screenViewsSchema: z.ZodType<
  readonly ScreenView[],
  readonly ScreenView[]
> = z.array(screenViewSchema);

export const screenAddInputSchema = z
  .object({
    projectId: z.string().min(1),
    /** Absent, the view is named after its Project id. */
    label: z.string().min(1).optional(),
  })
  .strict();

export const screenAttachRequestSchema: z.ZodType<
  ScreenAttachRequest,
  ScreenAttachRequest
> = z
  .object({
    viewId: z.string().min(1),
    projectId: z.string().min(1),
    seq: z.number().int().positive(),
  })
  .strict();

export const screenAttachReportSchema: z.ZodType<
  ScreenAttachReport,
  ScreenAttachReport
> = z
  .object({
    viewId: z.string().min(1),
    seq: z.number().int().positive(),
    answer: z.union([screenAttachSchema, z.null()]),
  })
  .strict();

export const screenViewsStateSchema: z.ZodType<
  ScreenViewsState,
  ScreenViewsState
> = z
  .object({
    revision: z.number().int().positive(),
    views: screenViewsSchema,
    dials: z.array(screenAttachRequestSchema),
  })
  .strict();

/**
 * `screen.views/v1` (desktopMain): the reader's views, their status and their
 * windows. `add`, `remove`, `open` and `retry` are the window's commands,
 * `deliver` is the answer to a dial the desktop part asked for through the
 * state's `dials`, and `watch` carries both. A read never fails because a view
 * could not be resolved: every failure is a status.
 */
export interface ScreenViews {
  /** The views, in the order they were added. */
  list(call?: CallArg): Promise<readonly ScreenView[]>;
  /** Spawns a view for a Project; a Project already watched is that view. */
  add(
    input: z.input<typeof screenAddInputSchema>,
    call?: CallArg,
  ): Promise<ScreenView>;
  remove(viewId: string, call?: CallArg): Promise<void>;
  /** Opens the view's window, or focuses it when it is already open. */
  open(viewId: string, call?: CallArg): Promise<void>;
  /** Asks for a fresh attach; the retry control and the heal loop use it. */
  retry(viewId: string, call?: CallArg): Promise<void>;
  /** Hands over the answer of a dial the desktop part requested. */
  deliver(report: ScreenAttachReport, call?: CallArg): Promise<void>;
  /**
   * The views and the dials, on subscribe (`revision` is the state the window
   * already holds, 0 when it holds none) and after every change.
   */
  watch(
    revision: number,
    listener: StreamListener<ScreenViewsState>,
    call?: CallArg,
  ): Disposable;
}

/** screen.views/v1, as the `screen` bundle provides it. */
export const ScreenViewsV1 = ref<ScreenViews>('screen.views/v1');

export const screenViewsMethods = {
  list: { input: noInput, output: screenViewsSchema, expose: 'desktop' },
  add: {
    input: screenAddInputSchema,
    output: screenViewSchema,
    expose: 'desktop',
  },
  remove: { input: z.string().min(1), output: z.void(), expose: 'desktop' },
  open: { input: z.string().min(1), output: z.void(), expose: 'desktop' },
  retry: { input: z.string().min(1), output: z.void(), expose: 'desktop' },
  deliver: {
    input: screenAttachReportSchema,
    output: z.void(),
    expose: 'desktop',
  },
  // A stream method's listener is its last tuple item: that is what tells the
  // desktop bridge the call is a stream (and not a process-local callback),
  // and the cursor the window passes back is its first item.
  watch: {
    input: z.tuple([
      z.number().int().nonnegative(),
      streamListener(screenViewsStateSchema),
    ]),
    output: disposableSchema,
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;
