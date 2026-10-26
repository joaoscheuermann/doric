// The window <-> main protocol of the desktop: what the preload exposes as
// `window.doric.desktop`, the IPC payloads behind it and the platform-internal
// `doric.shell/v1` contract. Browser-safe: types and zod schemas only; the
// Electron main process imports it to validate what a window sends.

import {
  type Cardinality,
  callScopeSchema,
  type JsonObject,
  type MethodExposure,
  methodExposures,
  windowScopeKey,
} from 'bundle/contracts';
import {
  LOCAL_KEY,
  type ResolvedEnvironment,
  STREAM_KEY,
  streamItemSchema,
} from 'bundle/runtime';
import { z } from 'zod';

/** The one `ipcMain.handle` channel of every window and the splash. */
export const DESKTOP_CHANNEL = 'doric:desktop';
/** Main -> window pushes (`webContents.send`). */
export const DESKTOP_PUSH_CHANNEL = 'doric:desktop:push';
/** Platform-internal contract between a window bootstrap and main [S8-11]. */
export const SHELL_CONTRACT = 'doric.shell/v1';

// Window description ---------------------------------------------------------

export interface WindowChrome {
  readonly titleBar: 'native' | 'integrated' | 'none';
  /** `tokens.titlebarHeight`, in CSS pixels. */
  readonly height: number;
  readonly safeArea: {
    readonly top: number;
    readonly left: number;
    readonly right: number;
  };
}

export const windowChromeSchema = z
  .object({
    titleBar: z.enum(['native', 'integrated', 'none']),
    height: z.number(),
    safeArea: z
      .object({ top: z.number(), left: z.number(), right: z.number() })
      .strict(),
  })
  .strict();

export type WindowMode = 'connected' | 'disconnected-copy' | 'last-good-core';

export interface WindowDescription {
  /** null for the splash (technical window). */
  readonly key: string | null;
  readonly kind: 'window' | 'technical';
  /**
   * The primary window (main opened it so): a failed core client there is a
   * core failure, not a ready window.
   */
  readonly primary: boolean;
  /** The path main loaded. */
  readonly path: string;
  /** The pinned client generation; null for the splash. */
  readonly generation: number | null;
  readonly chrome: WindowChrome;
  readonly mode: WindowMode;
  readonly tokens: Readonly<Record<string, string>>;
}

export const windowDescriptionSchema = z
  .object({
    key: z.union([z.string(), z.null()]),
    kind: z.enum(['window', 'technical']),
    primary: z.boolean(),
    path: z.string(),
    generation: z.union([z.number().int(), z.null()]),
    chrome: windowChromeSchema,
    mode: z.enum(['connected', 'disconnected-copy', 'last-good-core']),
    tokens: z.record(z.string(), z.string()),
  })
  .strict();

export interface WindowFailure {
  readonly kind: 'core' | 'bootstrap';
  readonly bundleId?: string;
  readonly message: string;
}

export const windowFailureSchema = z
  .object({
    kind: z.enum(['core', 'bootstrap']),
    bundleId: z.string().optional(),
    message: z.string(),
  })
  .strict();

// Close protocol -------------------------------------------------------------

export interface CloseRequest {
  readonly phase: 'close' | 'flush';
  readonly forced: boolean;
  /** Epoch milliseconds; 0 means none. */
  readonly deadline: number;
}

export const closeRequestSchema = z
  .object({
    phase: z.enum(['close', 'flush']),
    forced: z.boolean(),
    deadline: z.number(),
  })
  .strict();

export type CloseAnswer =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export const closeAnswerSchema = z.union([
  z.object({ allow: z.literal(true) }).strict(),
  z.object({ allow: z.literal(false), reason: z.string() }).strict(),
]);

// Window catalog -------------------------------------------------------------

/**
 * How the window calls one method of a remote contract: the tuple length used
 * to split a trailing call argument (null when the input is not a tuple)
 * [S8-12], whether the method cannot cross (`local_only`), whether it is a
 * stream [S8-20] and whether a desktop window may reach it (`expose`, absent
 * = no), as its provider's document declares.
 */
export interface RemoteMethodSpec {
  readonly tuple: number | null;
  readonly local: boolean;
  readonly stream: boolean;
  readonly expose?: MethodExposure;
}

export const remoteMethodSpecSchema = z
  .object({
    tuple: z.union([z.number().int().nonnegative(), z.null()]),
    local: z.boolean(),
    stream: z.boolean(),
    expose: z.enum(methodExposures).optional(),
  })
  .strict();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasLocal = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(hasLocal);
  }

  if (!isObject(value)) {
    return false;
  }

  return (
    Object.hasOwn(value, LOCAL_KEY) ||
    Object.entries(value).some(
      ([key, nested]) => key !== STREAM_KEY && hasLocal(nested),
    )
  );
};

/**
 * The remote spec of a method from its published JSON Schemas: a stream
 * method's listener is its last tuple item and its output the Disposable;
 * any other process-local value (a callback, a definition, a Disposable)
 * makes the method local, because only plain JSON and streams cross the
 * desktop bridge. `expose` is the method's exposure from its document.
 */
export const remoteMethodSpecFromSchema = (
  input: JsonObject,
  output: JsonObject,
  expose?: MethodExposure,
): RemoteMethodSpec => {
  const prefix = Array.isArray(input.prefixItems) ? input.prefixItems : null;
  const stream = streamItemSchema(input) !== undefined;
  const plain =
    stream && prefix !== null
      ? prefix.filter((item) => !(isObject(item) && STREAM_KEY in item))
      : input;

  return {
    tuple: input.type === 'array' && prefix !== null ? prefix.length : null,
    local: hasLocal(plain) || (!stream && hasLocal(output)),
    stream,
    ...(expose === undefined ? {} : { expose }),
  };
};

export interface RemoteContract {
  readonly id: string;
  readonly environment: 'desktopMain' | 'host';
  readonly bundleId: string;
  readonly version: string;
  readonly contractVersion: string;
  readonly cardinality: Cardinality;
  readonly methods: Readonly<Record<string, RemoteMethodSpec>>;
}

export const remoteContractSchema = z
  .object({
    id: z.string(),
    environment: z.enum(['desktopMain', 'host']),
    bundleId: z.string(),
    version: z.string(),
    contractVersion: z.string(),
    cardinality: z.enum(['one', 'many']),
    methods: z.record(z.string(), remoteMethodSpecSchema),
  })
  .strict();

export interface WindowPart {
  /** `doric://app/bundles/<id>@<version>/client/index.js`. */
  readonly entry: string;
  /** `doric://app/bundles/<id>@<version>/client/styles.css`, when shipped. */
  readonly styles?: string;
}

export interface WindowCatalog {
  readonly generation: number;
  /** The client environment main resolved for this generation. */
  readonly resolved: ResolvedEnvironment;
  /** Client parts by bundle ID. */
  readonly parts: Readonly<Record<string, WindowPart>>;
  /** Contracts reachable over the bridge (desktopMain and host). */
  readonly remote: readonly RemoteContract[];
  readonly hostId: string;
  readonly storageGeneration: number;
}

// Bridge calls ---------------------------------------------------------------

/**
 * The scope a window sends: a bounded opaque record (`callScopeSchema`). Which
 * keys a contract accepts is the declaration of its provider (`desktopScope`),
 * checked by main; here `windowKey` is refused in any case, so a window cannot
 * impersonate the key the dispatcher fills for it.
 */
const bridgeScopeSchema = callScopeSchema.refine(
  (scope) =>
    !Object.keys(scope).some(
      (key) => key.toLowerCase() === windowScopeKey.toLowerCase(),
    ),
  { message: `A window may not set the ${windowScopeKey} scope key.` },
);

export type BridgeScope = z.infer<typeof bridgeScopeSchema>;

export interface BridgeCallEnvelope {
  readonly id: string;
  readonly contract: string;
  readonly method: string;
  readonly input: unknown;
  /** Calling client bundle; null = the window platform (bootstrap). */
  readonly bundleId: string | null;
  readonly scope?: BridgeScope;
  /** Epoch milliseconds; 0 means none. */
  readonly deadline: number;
  readonly traceparent: string;
}

export const bridgeCallEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    contract: z.string(),
    method: z.string(),
    input: z.unknown(),
    bundleId: z.union([z.string(), z.null()]),
    scope: bridgeScopeSchema.optional(),
    deadline: z.number(),
    traceparent: z.string(),
  })
  .strict();

/** A ContractError as it crosses the IPC: never thrown through `invoke`. */
export interface BridgeError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export const bridgeErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .strict();

export type BridgeResultPayload =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: BridgeError };

export const bridgeResultPayloadSchema = z.union([
  z.object({ ok: z.literal(true), output: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: bridgeErrorSchema }).strict(),
]);

export type BridgeStreamEvent =
  | { readonly type: 'event'; readonly event: unknown }
  | { readonly type: 'end'; readonly error?: BridgeError };

// Preload API ----------------------------------------------------------------

export interface DoricDesktopApi {
  describeWindow(): Promise<WindowDescription>;
  ready(): Promise<void>;
  reportFailure(info: WindowFailure): Promise<void>;
  onCloseRequested(
    handler: (request: CloseRequest) => Promise<CloseAnswer | undefined>,
  ): () => void;
  onChromeChanged(listener: (chrome: WindowChrome) => void): () => void;
  catalog(): Promise<WindowCatalog>;
  call(envelope: BridgeCallEnvelope): Promise<BridgeResultPayload>;
  cancel(id: string): void;
  subscribe(
    envelope: BridgeCallEnvelope,
    listener: (event: BridgeStreamEvent) => void,
  ): () => void;
}

// IPC payloads ---------------------------------------------------------------

const generation = z.number().int().optional();

/** What the preload sends on `doric:desktop` (one handler in main). */
export const desktopRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('describeWindow'), generation }).strict(),
  z.object({ op: z.literal('ready'), generation }).strict(),
  z
    .object({
      op: z.literal('reportFailure'),
      info: windowFailureSchema,
      generation,
    })
    .strict(),
  z.object({ op: z.literal('catalog'), generation }).strict(),
  z
    .object({
      op: z.literal('call'),
      envelope: bridgeCallEnvelopeSchema,
      generation,
    })
    .strict(),
  z.object({ op: z.literal('cancel'), id: z.string(), generation }).strict(),
  z
    .object({
      op: z.literal('subscribe'),
      envelope: bridgeCallEnvelopeSchema,
      generation,
    })
    .strict(),
  z
    .object({ op: z.literal('unsubscribe'), id: z.string(), generation })
    .strict(),
  z
    .object({
      op: z.literal('closeAnswer'),
      id: z.string(),
      answer: closeAnswerSchema,
      generation,
    })
    .strict(),
]);

export type DesktopRequest = z.output<typeof desktopRequestSchema>;

/** What main pushes on `doric:desktop:push`. */
export const desktopPushSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('close-requested'),
      id: z.string(),
      request: closeRequestSchema,
    })
    .strict(),
  z.object({ type: z.literal('chrome'), chrome: windowChromeSchema }).strict(),
  z
    .object({ type: z.literal('event'), id: z.string(), event: z.unknown() })
    .strict(),
  z
    .object({
      type: z.literal('end'),
      id: z.string(),
      error: bridgeErrorSchema.optional(),
    })
    .strict(),
]);

export type DesktopPush = z.output<typeof desktopPushSchema>;

// doric.shell/v1 -------------------------------------------------------------

/** One entry of the effective keybinding table of a window. */
export interface ShellKeybinding {
  readonly key: string;
  readonly command: string;
}

export const shellKeybindingSchema = z
  .object({ key: z.string(), command: z.string() })
  .strict();

/** A client command main asks the window to run (section 18.3). */
export interface ShellCommandRequest {
  readonly id: string;
  readonly command: string;
  readonly input: unknown;
}

export const shellCommandRequestSchema = z
  .object({ id: z.string(), command: z.string(), input: z.unknown() })
  .strict();

export type ShellCommandResult =
  | { readonly id: string; readonly ok: true }
  | { readonly id: string; readonly ok: false; readonly error: BridgeError };

export const shellCommandResultSchema = z.union([
  z.object({ id: z.string(), ok: z.literal(true) }).strict(),
  z
    .object({ id: z.string(), ok: z.literal(false), error: bridgeErrorSchema })
    .strict(),
]);

/** A client diagnostics entry forwarded to main (main reports it to the host). */
export type ShellDiagnostic =
  | {
      readonly kind: 'quarantine';
      readonly bundleId: string;
      readonly reason: {
        readonly code: string;
        readonly message: string;
      };
    }
  | {
      readonly kind: 'report';
      readonly entry: {
        readonly bundleId: string;
        readonly kind: string;
        readonly message: string;
        readonly details?: unknown;
      };
    }
  | { readonly kind: 'recovery'; readonly reason: string };

export const shellDiagnosticSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('quarantine'),
      bundleId: z.string(),
      reason: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('report'),
      entry: z
        .object({
          bundleId: z.string(),
          kind: z.string(),
          message: z.string(),
          details: z.unknown().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('recovery'), reason: z.string() }).strict(),
]);

/**
 * Methods of `doric.shell/v1`, callable only with `bundleId: null` from a
 * window (section 14.4). Streams take no input and deliver items through
 * `subscribe`; the others are plain calls; `log` and `diagnostic` are
 * fire-and-forget from the window.
 */
export const shellMethods = {
  keybindings: { stream: true },
  keybinding: { stream: false },
  commands: { stream: true },
  commandResult: { stream: false },
  log: { stream: false },
  diagnostic: { stream: false },
  // Stage 9: the host connection status (D9-5). The D9-6 `notify` call is
  // gone since WP-10N (notifications are decided in desktopMain).
  connection: { stream: true },
  // `doric.browser/v1`: an https URL main opens in the system browser.
  openExternal: { stream: false },
} as const;

export type ShellMethod = keyof typeof shellMethods;
