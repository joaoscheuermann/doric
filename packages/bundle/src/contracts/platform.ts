import { z } from 'zod';

import {
  disposableSchema,
  functionSchema,
  type MethodSpecs,
  type StreamListener,
  streamListener,
} from './basic/common.js';
import type { Keybinding, MenuItem } from './basic/menus.js';
import { keybindingSchema, menuItemSchema } from './basic/menus.js';
import {
  type StorageIdentity,
  storageIdentitySchema,
} from './basic/storage.js';
import type { ElementConstructor } from './basic/ui.js';
import type { OpenWindowRequest } from './basic/windows.js';
import { openWindowRequestSchema } from './basic/windows.js';
import {
  type CallArg,
  type Caller,
  type CallScope,
  callScopeSchema,
} from './call.js';
import type { Disposable } from './context.js';
import { defineHook, definePlatformHooks, ref } from './define.js';
import type { Environment } from './ids.js';
import { networkMethods } from './network.js';
import type { JsonObject } from './types.js';

// Platform hooks ------------------------------------------------------------

const empty = z.object({}).strict();

const activation = z
  .object({
    bundleId: z.string(),
    version: z.string(),
    generation: z.number().int(),
    environment: z.enum(['host', 'desktopMain', 'client']),
  })
  .strict();

const generationOwnerSchema = z
  .object({ generation: z.number().int(), incarnation: z.number().int() })
  .strict();

const generationEntrySchema = generationOwnerSchema
  .extend({
    state: z.enum(['starting', 'active', 'draining', 'stopped', 'failed']),
  })
  .strict();

/** A generation change as the kernel reports it to each live generation. */
const generationChangeSchema = z
  .object({
    event: z.enum(['activated', 'draining', 'lost', 'stopped']),
    generation: z.number().int(),
    incarnation: z.number().int(),
    /** The receiving generation process. */
    self: generationOwnerSchema,
    /** The live generations (active or draining) after the change. */
    live: z.array(generationEntrySchema),
    /** `lost` only: the work holds the lost generation kept, by owner. */
    holds: z
      .array(
        z
          .object({
            bundleId: z.string(),
            key: z.string(),
            label: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const peerSignalSchema = z
  .object({
    topic: z.string().min(1).max(128),
    payload: z.unknown(),
    from: generationOwnerSchema.extend({ bundleId: z.string() }).strict(),
    self: generationOwnerSchema,
    live: z.array(generationEntrySchema),
  })
  .strict();

/** Lifecycle hooks the platform defines in the active hooks/v1 of each environment. */
export const AppHooksV1 = definePlatformHooks('doric.app.hooks/v1', {
  onActivateHook: defineHook({ kind: 'observe', input: activation }),
  onDeactivateHook: defineHook({ kind: 'observe', input: activation }),
  /** Host start, before the host listens: activation order, awaited, failure fatal. */
  onHostStartHook: defineHook({ kind: 'sequence', input: empty }),
  /** Host stop, after the HTTP and socket close: reverse activation order, awaited. */
  onHostStopHook: defineHook({
    kind: 'sequence',
    order: 'reverse',
    input: empty,
  }),
  /**
   * Each live generation hears every change of the generation set; the
   * handlers of that generation run, so a bundle reacts in its own process.
   */
  /**
   * Each handler gets only its own bundle's `holds`: a hold names work of the
   * bundle that took it, and other bundles must not learn its key or label.
   */
  onGenerationChangedHook: defineHook({
    kind: 'observe',
    input: generationChangeSchema,
    forOwner: (change, bundleId) =>
      change.holds === undefined
        ? change
        : {
            ...change,
            holds: change.holds.filter((hold) => hold.bundleId === bundleId),
          },
  }),
  /**
   * A bundle's `doric.generation/v1.signal`, delivered to the other live
   * generations of the same bundle only: a handler of another bundle skips it.
   */
  onPeerSignalHook: defineHook({
    kind: 'observe',
    input: peerSignalSchema,
    forOwner: (signal, bundleId) =>
      signal.from.bundleId === bundleId ? signal : undefined,
  }),
  onHostReadyHook: defineHook({ kind: 'observe', input: empty }),
  onAppReadyHook: defineHook({ kind: 'observe', input: empty }),
  onAppActivateHook: defineHook({ kind: 'observe', input: empty }),
  onBeforeQuitHook: defineHook({ kind: 'decide', input: empty }),
  onGenerationReadyHook: defineHook({
    kind: 'observe',
    input: z.object({ generation: z.number().int() }).strict(),
  }),
  onConnectionChangedHook: defineHook({
    kind: 'observe',
    input: z.object({ connected: z.boolean() }).strict(),
  }),
});

/** Window lifecycle hooks each client window bootstrap defines. */
export const WindowHooksV1 = definePlatformHooks('doric.window.hooks/v1', {
  onCloseHook: defineHook({ kind: 'decide', input: empty }),
  onFlushHook: defineHook({ kind: 'observe', input: empty }),
});

// Catalog and diagnostics shapes ---------------------------------------------

export type Phase = 'foundation' | 'core' | 'others';

export type BundleState = 'active' | 'quarantined' | 'disabled' | 'inactive';

export const quarantineCodes = [
  'invalid_manifest',
  'invalid_descriptor',
  'invalid_part',
  'duplicate_id',
  'engines_unsatisfied',
  'missing_dependency',
  'incompatible_version',
  'dependency_quarantined',
  'unchosen_provider',
  'cardinality_mismatch',
  'foundation_requires',
  'dependency_cycle',
  'activate_failed',
  'registration_failed',
  'skill_invalid',
  'generation_failed',
  'kernel_requires_generation',
] as const;

export type QuarantineCode = (typeof quarantineCodes)[number];

export interface QuarantineReason {
  readonly code: QuarantineCode;
  readonly message: string;
  readonly contract?: string;
}

const phaseSchema = z.enum(['foundation', 'core', 'others']);

const stateSchema = z.enum(['active', 'quarantined', 'disabled', 'inactive']);

const environmentSchema = z.enum(['host', 'desktopMain', 'client']);

export const quarantineReasonSchema = z
  .object({
    code: z.enum(quarantineCodes),
    message: z.string(),
    contract: z.string().optional(),
  })
  .strict();

/** The validated v1 manifest as the catalog publishes it. */
export interface CatalogManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly engines: { readonly doric: string };
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly optional?: readonly string[];
  /** The scope keys a desktop window may send to each provided contract. */
  readonly desktopScope?: Readonly<Record<string, readonly string[]>>;
  readonly description?: string;
}

export const catalogManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    id: z.string(),
    version: z.string(),
    engines: z.object({ doric: z.string() }).strict(),
    provides: z.array(z.string()),
    requires: z.array(z.string()),
    optional: z.array(z.string()).optional(),
    desktopScope: z.record(z.string(), z.array(z.string())).optional(),
    description: z.string().optional(),
  })
  .strict();

export interface CatalogComposition {
  readonly core: string;
  readonly enabled: readonly string[];
  readonly providers: Readonly<Record<string, string>>;
}

const compositionShape = z
  .object({
    core: z.string(),
    enabled: z.array(z.string()),
    providers: z.record(z.string(), z.string()),
  })
  .strict();

export interface ContractProvider {
  readonly bundleId: string;
  /** The contract version the provider declares in `provides`. */
  readonly version: string;
  readonly bundleVersion: string;
}

export interface CatalogBundle {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly state: BundleState;
  readonly phase?: Phase;
  readonly manifest?: CatalogManifest;
  readonly reasons: readonly QuarantineReason[];
}

export interface CatalogContract {
  readonly id: string;
  readonly environment: Environment;
  readonly cardinality: 'one' | 'many';
  readonly providers: readonly ContractProvider[];
}

export interface CatalogSnapshot {
  readonly generation: number;
  readonly composition: CatalogComposition;
  readonly bundles: readonly CatalogBundle[];
  /** Activation order of this environment (hooks providers order handlers by it). */
  readonly order: readonly string[];
  readonly contracts: readonly CatalogContract[];
  /** The storage backend's identity, once the host resolved it. */
  readonly storage?: StorageIdentity;
}

export const catalogSnapshotSchema: z.ZodType<CatalogSnapshot> = z
  .object({
    generation: z.number().int(),
    composition: compositionShape,
    bundles: z.array(
      z
        .object({
          id: z.string(),
          version: z.string(),
          description: z.string().optional(),
          state: stateSchema,
          phase: phaseSchema.optional(),
          manifest: catalogManifestSchema.optional(),
          reasons: z.array(quarantineReasonSchema),
        })
        .strict(),
    ),
    order: z.array(z.string()),
    contracts: z.array(
      z
        .object({
          id: z.string(),
          environment: environmentSchema,
          cardinality: z.enum(['one', 'many']),
          providers: z.array(
            z
              .object({
                bundleId: z.string(),
                version: z.string(),
                bundleVersion: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    storage: storageIdentitySchema.optional(),
  })
  .strict();

/** One file of a bundle the host distributes to the desktop. */
export interface DistributionFile {
  /** Relative to the bundle's dist directory, with `/` separators. */
  readonly path: string;
  /** Lowercase hex SHA-256 of the file bytes. */
  readonly sha256: string;
  readonly size: number;
}

/** The built parts a distributed bundle ships, as paths of its files. */
export interface DistributionParts {
  readonly desktopMain?: string;
  readonly client?: string;
  readonly clientStyles?: string;
  readonly contracts?: string;
}

/** One bundle of a host generation, as the desktop receives it. */
export interface DistributionBundle {
  readonly id: string;
  readonly version: string;
  /** The bundle's state in the host environment. */
  readonly state: BundleState;
  /** The host-side quarantine reasons. */
  readonly reasons: readonly QuarantineReason[];
  readonly manifest?: CatalogManifest;
  /** `dist/contracts.json` as JSON; the desktop validates it on resolution. */
  readonly descriptor?: JsonObject;
  /** desktop/**, client/**, contracts/**.js, schemas/**, manifest.json, contracts.json. */
  readonly files: readonly DistributionFile[];
  readonly parts: DistributionParts;
}

/** `doric.catalog/v1.distribution()`: what the desktop needs of a host generation. */
export interface DistributionCatalog {
  /** The host generation (restarts at 1 with every host process). */
  readonly generation: number;
  /** Random per host process: with `generation`, identifies a host generation. */
  readonly hostBoot: string;
  /** The host platform version (informative). */
  readonly platformVersion: string;
  readonly composition: CatalogComposition;
  /** The storage backend's identity, once the host resolved it. */
  readonly storage?: StorageIdentity;
  /** The host environment snapshot (`doric.catalog/v1.get()`). */
  readonly host: CatalogSnapshot;
  readonly bundles: readonly DistributionBundle[];
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const distributionFileSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    size: z.number().int().nonnegative(),
  })
  .strict();

export const distributionCatalogSchema: z.ZodType<DistributionCatalog> = z
  .object({
    generation: z.number().int(),
    hostBoot: z.string().min(1),
    platformVersion: z.string(),
    composition: compositionShape,
    storage: storageIdentitySchema.optional(),
    host: catalogSnapshotSchema,
    bundles: z.array(
      z
        .object({
          id: z.string(),
          version: z.string(),
          state: stateSchema,
          reasons: z.array(quarantineReasonSchema),
          manifest: catalogManifestSchema.optional(),
          descriptor: z.record(z.string(), z.unknown()).optional(),
          files: z.array(distributionFileSchema),
          parts: z
            .object({
              desktopMain: z.string().optional(),
              client: z.string().optional(),
              clientStyles: z.string().optional(),
              contracts: z.string().optional(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict() as z.ZodType<DistributionCatalog>;

/** `doric.catalog/v1.artifact()`: one distributed file by hash. */
export interface DistributionArtifact {
  readonly sha256: string;
  /** The file bytes, base64 (keeps the envelope JSON). */
  readonly base64: string;
}

export const distributionArtifactSchema = z
  .object({ sha256: sha256Schema, base64: z.string() })
  .strict();

/** An item of `doric.catalog/v1.watch()`: a host generation was published. */
export interface CatalogChange {
  readonly generation: number;
}

export const catalogChangeSchema = z
  .object({ generation: z.number().int() })
  .strict();

export interface DiagnosticError {
  readonly at: string;
  readonly bundleId: string;
  readonly kind: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface DiagnosticBundle {
  readonly id: string;
  readonly version: string;
  readonly state: BundleState;
  readonly phase?: Phase;
  readonly reasons: readonly QuarantineReason[];
  readonly activationMs?: number;
}

export interface Diagnostics {
  readonly generation: number;
  readonly mode: 'normal' | 'recovery';
  readonly recovery?: { readonly reason: string };
  readonly issues: readonly string[];
  readonly bundles: readonly DiagnosticBundle[];
  /** Bounded to the most recent entries per bundle. */
  readonly errors: readonly DiagnosticError[];
  /** Bundles whose manifest requires each contract (deprecation tracking). */
  readonly consumers: Readonly<Record<string, readonly string[]>>;
}

export const diagnosticsSchema: z.ZodType<Diagnostics> = z
  .object({
    generation: z.number().int(),
    mode: z.enum(['normal', 'recovery']),
    recovery: z.object({ reason: z.string() }).strict().optional(),
    issues: z.array(z.string()),
    bundles: z.array(
      z
        .object({
          id: z.string(),
          version: z.string(),
          state: stateSchema,
          phase: phaseSchema.optional(),
          reasons: z.array(quarantineReasonSchema),
          activationMs: z.number().optional(),
        })
        .strict(),
    ),
    errors: z.array(
      z
        .object({
          at: z.string(),
          bundleId: z.string(),
          kind: z.string(),
          message: z.string(),
          details: z.unknown().optional(),
        })
        .strict(),
    ),
    consumers: z.record(z.string(), z.array(z.string())),
  })
  .strict();

export interface DiagnosticReport {
  readonly bundleId: string;
  readonly kind: string;
  readonly message: string;
  readonly details?: unknown;
}

export const diagnosticReportSchema = z
  .object({
    bundleId: z.string(),
    kind: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .strict();

export interface BundleDescription {
  readonly bundleId: string;
  readonly version: string;
  readonly generation: number;
  readonly environment: Environment;
}

export const bundleDescriptionSchema = z
  .object({
    bundleId: z.string(),
    version: z.string(),
    generation: z.number().int(),
    environment: environmentSchema,
  })
  .strict();

export interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly bundleId: string;
  readonly version: string;
  readonly generation: number;
  readonly environment: Environment;
  readonly scope?: CallScope;
  readonly traceId?: string;
}

export const logRecordSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    fields: z.record(z.string(), z.unknown()).optional(),
    bundleId: z.string(),
    version: z.string(),
    generation: z.number().int(),
    environment: environmentSchema,
    scope: callScopeSchema.optional(),
    traceId: z.string().optional(),
  })
  .strict();

export type MenuSkeleton = readonly {
  readonly id: string;
  readonly label: string;
  readonly role?: string;
  readonly submenu?: MenuSkeleton;
}[];

interface MenuSkeletonEntry {
  readonly id: string;
  readonly label: string;
  readonly role?: string;
  readonly submenu?: readonly MenuSkeletonEntry[];
}

const menuSkeletonEntrySchema: z.ZodType<MenuSkeletonEntry> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      label: z.string(),
      role: z.string().optional(),
      submenu: z.array(menuSkeletonEntrySchema).optional(),
    })
    .strict(),
);

const ownerSchema = z
  .object({
    bundleId: z.string(),
    version: z.string(),
    generation: z.number().int(),
  })
  .strict();

// Platform service APIs -----------------------------------------------------

export interface DoricCatalog {
  get(call?: CallArg): CatalogSnapshot;
  /** API mínima [S8-9] (host only): the generation the desktop resolves. */
  distribution(call?: CallArg): Promise<DistributionCatalog>;
  /** API mínima [S8-9] (host only): a file listed in a retained generation. */
  artifact(
    request: { readonly sha256: string },
    call?: CallArg,
  ): Promise<DistributionArtifact>;
  /** API mínima [S8-9] (host only): one item per published generation. */
  watch(listener: StreamListener<CatalogChange>, call?: CallArg): Disposable;
  /**
   * Recovery (host only, HR-6): leaves a bundle out of `enabled` through the
   * host's composition overrides and publishes a new generation.
   */
  disable(
    request: { readonly bundleId: string },
    call?: CallArg,
  ): Promise<void>;
  /**
   * Recovery (host only, HR-6): clears the composition overrides, returning
   * to the composition as written, and publishes a new generation.
   */
  resetComposition(call?: CallArg): Promise<void>;
}

export interface DoricDiagnostics {
  get(call?: CallArg): Diagnostics;
  report(entry: DiagnosticReport, call?: CallArg): void;
}

export interface DoricBundle {
  /** Identity of the calling bundle in this generation and environment. */
  describe(call?: CallArg): BundleDescription;
}

/** API mínima: the sink through which a log/v1 provider reaches the platform's log files. */
export interface DoricLog {
  write(record: LogRecord, call?: CallArg): void;
}

/**
 * The native window API (desktopMain): `open` receives the request the core's
 * policy let through, either an app route (`path`, loaded by the shell with
 * the app's preload and contracts) or a foreign URL (`url` and `partition`)
 * rendered in its own session.
 */
export interface DoricWindows {
  open(request: OpenWindowRequest, call?: CallArg): Promise<void>;
  focusOrOpen(key: string, call?: CallArg): Promise<void>;
  /** API mínima [S8-6]: the last path main stored for a key, or null. */
  lastPath(key: string, call?: CallArg): Promise<string | null>;
  /**
   * Stage 9 (D9-7): focuses the window of `key` without navigating it; true
   * when such a window existed and was focused.
   */
  focus(key: string, call?: CallArg): Promise<boolean>;
  /**
   * 1.1.0: for a view window, loads the host-relative `path` resolved against
   * the origin the app reaches the host on. A path window is not navigable this
   * way and fails `invalid_input`; a key that is not open fails `not_found`.
   */
  navigate(input: { key: string; path: string }, call?: CallArg): Promise<void>;
  /**
   * 1.2.0: captures `rect` (CSS px of the window's viewport) of an open path
   * window as a PNG: its bytes as base64, its size in device pixels and the
   * device pixels per CSS px it was taken at. A key that is not open fails
   * `not_found`; a view window, or a rectangle outside the viewport, fails
   * `invalid_input`; a capture main could not take fails `unavailable`.
   */
  capture(input: WindowCaptureRequest, call?: CallArg): Promise<WindowCapture>;
}

/** The longest side of a window capture, in CSS px. */
export const WINDOW_CAPTURE_MAX_SIDE = 4096;

export interface WindowCaptureRequest {
  readonly key: string;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface WindowCapture {
  /** The PNG bytes, base64. */
  readonly png: string;
  /** Device pixels. */
  readonly width: number;
  readonly height: number;
  /** Device pixels per CSS px. */
  readonly scale: number;
}

const captureSide = z.number().positive().max(WINDOW_CAPTURE_MAX_SIDE);

export const windowCaptureRequestSchema = z
  .object({
    key: z.string().min(1),
    rect: z
      .object({
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
        width: captureSide,
        height: captureSide,
      })
      .strict(),
  })
  .strict();

export const windowCaptureSchema = z
  .object({
    png: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    scale: z.number().positive(),
  })
  .strict();

export interface DoricMenus {
  setSkeleton(skeleton: MenuSkeleton, call?: CallArg): Promise<void>;
  add(
    item: MenuItem & { readonly owner: Caller },
    call?: CallArg,
  ): Promise<void>;
  addKeybinding(
    binding: Keybinding & { readonly owner: Caller },
    call?: CallArg,
  ): Promise<void>;
  setContext(
    entry: {
      readonly windowKey: string;
      readonly key: 'path' | 'focus';
      readonly value: string | null;
    },
    call?: CallArg,
  ): Promise<void>;
}

export interface DoricCache {
  /** Absolute cache directory of the calling bundle. */
  directory(call?: CallArg): Promise<string>;
}

export interface DoricTokens {
  get(call?: CallArg): Promise<Readonly<Record<string, string>>>;
}

/** Outcome of a one-time storage migration (`doric.migrations/v1`). */
export type MigrationResult = (typeof migrationResults)[number];

export interface MigrationRequest {
  /** The localStorage key to copy from the packaged origin. */
  readonly key: string;
  /** The name of the desktop state record that marks the copy done. */
  readonly marker: string;
}

/**
 * One-time copies of a window's storage from the packaged origin, run by the
 * platform. The caller chooses only the key and the marker: the origins and
 * the pages involved belong to the platform.
 */
export interface DoricMigrations {
  storage(request: MigrationRequest, call?: CallArg): Promise<MigrationResult>;
}

/** One native notification (decision 81). */
export interface NotificationRequest {
  readonly title: string;
  readonly body: string;
}

export const notificationRequestSchema = z
  .object({ title: z.string(), body: z.string() })
  .strict();

export interface DoricNotifications {
  /**
   * Main bounds each line to 200 code points; an empty title or an
   * unsupported platform is a silent no-op; an OS refusal is only logged.
   */
  show(request: NotificationRequest, call?: CallArg): Promise<void>;
}

/**
 * Stage 9 (D9-2), client only: custom elements and the services they get.
 * Only the window's active `ui/v1` provider may call it (`not_owner`).
 */
export interface DoricElements {
  /** Records `owner` for `tag` and calls `customElements.define`. */
  define(
    input: {
      readonly tag: string;
      readonly element: ElementConstructor;
      readonly owner: Caller;
    },
    call?: CallArg,
  ): Disposable;
  /** The active owner of a defined tag, or undefined (absent, quarantined or disposed). */
  owner(tag: string, call?: CallArg): Caller | undefined;
  /** Assigns `element.services`: a child scope of the tag owner's services. */
  attach(element: object, call?: CallArg): void;
  /** Disposes that child scope; idempotent. */
  release(element: object, call?: CallArg): void;
}

/** Stage 9 (D9-5): the host connection status a window shows. */
export type ConnectionStatus = 'connected' | 'disconnected';

export interface DoricConnection {
  /** `disconnected` until main reports the first status. */
  status(call?: CallArg): ConnectionStatus;
  /** Called on every change (deduplicated); not called with the current value. */
  subscribe(
    listener: (status: ConnectionStatus) => void,
    call?: CallArg,
  ): Disposable;
}

/**
 * Opens a page in the system browser, outside the app (client only). A
 * window may not open windows of its own; this is the one way out, and it
 * takes only an `https:` URL, which main hands to the operating system.
 */
export interface DoricBrowser {
  open(url: string, call?: CallArg): Promise<void>;
}

/**
 * A unit of work a generation keeps running until it is disposed. The owner
 * is the calling bundle (`call.caller.bundleId`), never part of the input; the
 * key is opaque to the platform.
 */
export interface WorkHold {
  readonly key: string;
  readonly label?: string;
}

export const workHoldSchema = z
  .object({
    key: z.string().min(1).max(256),
    label: z.string().max(256).optional(),
  })
  .strict();

export type GenerationState =
  | 'starting'
  | 'active'
  | 'draining'
  | 'stopped'
  | 'failed';

export interface GenerationDescription {
  readonly generation: number;
  readonly incarnation: number;
  readonly state: GenerationState;
}

export const generationDescriptionSchema = z
  .object({
    generation: z.number().int(),
    incarnation: z.number().int(),
    state: z.enum(['starting', 'active', 'draining', 'stopped', 'failed']),
  })
  .strict();

/** A signal from a bundle's generation to the same bundle in the other live generations. */
export interface PeerSignal {
  readonly topic: string;
  readonly payload?: unknown;
}

export const peerSignalSchemaInput = z
  .object({
    topic: z.string().min(1).max(128),
    payload: z.unknown().optional(),
  })
  .strict();

/**
 * API mínima: the bundle generation of the caller's operation. A work hold
 * keeps that generation alive (draining) until it is disposed; a signal
 * reaches the other live generations through `onPeerSignalHook`.
 */
export interface DoricGeneration {
  describe(call?: CallArg): Promise<GenerationDescription>;
  hold(work: WorkHold, call?: CallArg): Disposable;
  signal(signal: PeerSignal, call?: CallArg): Promise<void>;
}

export const startupLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

/**
 * The host's startup record (host only): the stage a failure is reported at,
 * and the flat log lines of the startup sequence.
 */
export interface DoricStartup {
  stage(name: string, call?: CallArg): Promise<void>;
  log(
    record: {
      readonly level: 'debug' | 'info' | 'warn' | 'error';
      readonly fields: Readonly<Record<string, unknown>>;
      readonly message: string;
    },
    call?: CallArg,
  ): Promise<void>;
}

export const DoricCatalogV1 = ref<DoricCatalog>('doric.catalog/v1');
export const DoricDiagnosticsV1 = ref<DoricDiagnostics>('doric.diagnostics/v1');
export const DoricBundleV1 = ref<DoricBundle>('doric.bundle/v1');
export const DoricLogV1 = ref<DoricLog>('doric.log/v1');
export const DoricWindowsV1 = ref<DoricWindows>('doric.windows/v1');
export const DoricMenusV1 = ref<DoricMenus>('doric.menus/v1');
export const DoricCacheV1 = ref<DoricCache>('doric.cache/v1');
export const DoricMigrationsV1 = ref<DoricMigrations>('doric.migrations/v1');
export const DoricTokensV1 = ref<DoricTokens>('doric.tokens/v1');
export const DoricNotificationsV1 = ref<DoricNotifications>(
  'doric.notifications/v1',
);
export const DoricGenerationV1 = ref<DoricGeneration>('doric.generation/v1');
export const DoricStartupV1 = ref<DoricStartup>('doric.startup/v1');
export const DoricElementsV1 = ref<DoricElements>('doric.elements/v1');
export const DoricConnectionV1 = ref<DoricConnection>('doric.connection/v1');
export const DoricBrowserV1 = ref<DoricBrowser>('doric.browser/v1');

/**
 * The fixed origin of the vendored draw.io editor (S1), and the only place
 * this value is defined. The editor document is always
 * `${DRAWIO_ORIGIN}/index.html`; desktopMain serves it from
 * `assets/drawio/webapp/` and resolves nothing over the network.
 */
export const DRAWIO_ORIGIN = 'https://drawio.doric.invalid';

/** Whether the editor origin can be used, as `doric.drawio/v1.describe` reports it. */
export interface DrawioDescription {
  /** Whether the origin answers: the webapp exists and the handler was registered. */
  readonly available: boolean;
  /** The version of the vendored webapp, from `assets/drawio/manifest.json`. Present exactly when `available` is true. */
  readonly version?: string;
  /**
   * Why the origin is unavailable. Present exactly when `available` is false:
   * `missing-assets` when the manifest is absent or unreadable,
   * `handler-failed` when registering the protocol handler threw.
   */
  readonly reason?: 'missing-assets' | 'handler-failed';
}

export const drawioDescriptionSchema: z.ZodType<DrawioDescription> = z
  .object({
    available: z.boolean(),
    version: z.string().optional(),
    reason: z.enum(['missing-assets', 'handler-failed']).optional(),
  })
  .strict();

/**
 * The editor origin's state (desktopMain only). `describe` takes no input
 * and never rejects for an unavailable origin: it resolves with
 * `available: false` and the reason. The value is fixed for the life of the
 * main process, so repeated calls give the same answer.
 */
export interface DoricDrawio {
  describe(call?: CallArg): Promise<DrawioDescription>;
}

export const DoricDrawioV1 = ref<DoricDrawio>('doric.drawio/v1');

const noInput = z.tuple([]);

const elementSchema = z.custom<object>(
  (value) => typeof value === 'object' && value !== null,
  { message: 'Expected an element.' },
);

export const connectionStatusSchema = z.enum(['connected', 'disconnected']);

/** Whether a value is an absolute `https:` URL. */
const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/** A URL the system browser may open: absolute and `https:` only. */
export const browserUrlSchema = z
  .string()
  .max(8192)
  .refine(isHttpsUrl, { message: 'Expected an https URL.' });

/** A localStorage key a migration may copy: bounded, with no origin in it. */
export const migrationKeyPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
/** A migration marker, the name of its record in the desktop state. */
export const migrationMarkerPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export const migrationResults = [
  'migrated',
  'none',
  'skipped',
  'failed',
] as const;

const migrationRequestSchema = z
  .object({
    key: z.string().regex(migrationKeyPattern),
    marker: z.string().regex(migrationMarkerPattern),
  })
  .strict();

export interface PlatformContractSpec {
  readonly environments: readonly Environment[];
  readonly methods: MethodSpecs;
}

/** Method specifications of the `doric.*` services, by contract ID. */
export const platformContracts = Object.freeze({
  'doric.network/v1': { environments: ['host'], methods: networkMethods },
  // [S8-7] desktopMain and client have their own catalog and diagnostics.
  'doric.catalog/v1': {
    environments: ['host', 'desktopMain', 'client'],
    methods: {
      get: {
        input: noInput,
        output: catalogSnapshotSchema,
        expose: 'desktop',
      },
      distribution: {
        input: noInput,
        output: distributionCatalogSchema,
        expose: 'desktop',
      },
      artifact: {
        input: z.object({ sha256: sha256Schema }).strict(),
        output: distributionArtifactSchema,
        expose: 'desktop',
      },
      watch: {
        input: z.tuple([streamListener(catalogChangeSchema)]),
        output: disposableSchema,
        expose: 'desktop',
      },
      disable: {
        input: z.object({ bundleId: z.string().min(1) }).strict(),
        output: z.void(),
        expose: 'desktop',
      },
      resetComposition: {
        input: noInput,
        output: z.void(),
        expose: 'desktop',
      },
    },
  },
  'doric.diagnostics/v1': {
    environments: ['host', 'desktopMain', 'client'],
    methods: {
      get: { input: noInput, output: diagnosticsSchema },
      report: {
        input: diagnosticReportSchema,
        output: z.void(),
        expose: 'desktop',
      },
    },
  },
  'doric.bundle/v1': {
    environments: ['host', 'desktopMain', 'client'],
    methods: { describe: { input: noInput, output: bundleDescriptionSchema } },
  },
  'doric.log/v1': {
    environments: ['host', 'desktopMain', 'client'],
    methods: { write: { input: logRecordSchema, output: z.void() } },
  },
  'doric.windows/v1': {
    environments: ['desktopMain'],
    methods: {
      open: { input: openWindowRequestSchema, output: z.void() },
      focusOrOpen: { input: z.string(), output: z.void() },
      lastPath: { input: z.string(), output: z.union([z.string(), z.null()]) },
      focus: { input: z.string(), output: z.boolean() },
      navigate: {
        input: z
          .object({ key: z.string(), path: z.string().startsWith('/') })
          .strict(),
        output: z.void(),
      },
      capture: {
        input: windowCaptureRequestSchema,
        output: windowCaptureSchema,
      },
    },
  },
  'doric.menus/v1': {
    environments: ['desktopMain'],
    methods: {
      setSkeleton: {
        input: z.array(menuSkeletonEntrySchema),
        output: z.void(),
      },
      add: {
        input: menuItemSchema.extend({ owner: ownerSchema }),
        output: z.void(),
      },
      addKeybinding: {
        input: keybindingSchema.extend({ owner: ownerSchema }),
        output: z.void(),
      },
      setContext: {
        input: z
          .object({
            windowKey: z.string(),
            key: z.enum(['path', 'focus']),
            value: z.union([z.string(), z.null()]),
          })
          .strict(),
        output: z.void(),
      },
    },
  },
  'doric.cache/v1': {
    environments: ['desktopMain'],
    methods: { directory: { input: noInput, output: z.string() } },
  },
  'doric.migrations/v1': {
    environments: ['desktopMain'],
    methods: {
      storage: {
        input: migrationRequestSchema,
        output: z.enum(migrationResults),
      },
    },
  },
  'doric.generation/v1': {
    environments: ['host'],
    methods: {
      describe: { input: noInput, output: generationDescriptionSchema },
      hold: { input: workHoldSchema, output: disposableSchema },
      signal: { input: peerSignalSchemaInput, output: z.void() },
    },
  },
  'doric.startup/v1': {
    environments: ['host'],
    methods: {
      stage: { input: z.string().min(1).max(64), output: z.void() },
      log: {
        input: z
          .object({
            level: startupLevelSchema,
            fields: z.record(z.string(), z.unknown()),
            message: z.string(),
          })
          .strict(),
        output: z.void(),
      },
    },
  },
  'doric.tokens/v1': {
    environments: ['client', 'desktopMain'],
    methods: {
      get: { input: noInput, output: z.record(z.string(), z.string()) },
    },
  },
  // WP-10N: desktopMain only again; the notifications bundle decides there.
  'doric.notifications/v1': {
    environments: ['desktopMain'],
    methods: { show: { input: notificationRequestSchema, output: z.void() } },
  },
  'doric.elements/v1': {
    environments: ['client'],
    methods: {
      define: {
        input: z
          .object({
            tag: z.string(),
            element: functionSchema<ElementConstructor>(),
            owner: ownerSchema,
          })
          .strict(),
        output: disposableSchema,
      },
      owner: {
        input: z.string(),
        output: ownerSchema.optional(),
      },
      attach: { input: elementSchema, output: z.void() },
      release: { input: elementSchema, output: z.void() },
    },
  },
  'doric.connection/v1': {
    environments: ['client'],
    methods: {
      status: { input: noInput, output: connectionStatusSchema },
      subscribe: {
        input: functionSchema<(status: ConnectionStatus) => void>(),
        output: disposableSchema,
      },
    },
  },
  'doric.browser/v1': {
    environments: ['client'],
    methods: { open: { input: browserUrlSchema, output: z.void() } },
  },
  'doric.drawio/v1': {
    environments: ['desktopMain'],
    methods: { describe: { input: noInput, output: drawioDescriptionSchema } },
  },
} satisfies Record<string, PlatformContractSpec>);

export type PlatformContractId = keyof typeof platformContracts;
