import { z } from 'zod';

import type { MethodSpecs } from './basic/common.js';
import type { Keybinding, MenuItem } from './basic/menus.js';
import { keybindingSchema, menuItemSchema } from './basic/menus.js';
import {
  type StorageIdentity,
  storageIdentitySchema,
} from './basic/storage.js';
import type { OpenWindowRequest } from './basic/windows.js';
import { openWindowRequestSchema } from './basic/windows.js';
import type { CallArg, Caller, CallScope } from './call.js';
import { defineHook, definePlatformHooks, ref } from './define.js';
import type { Environment } from './ids.js';

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

/** Lifecycle hooks the platform defines in the active hooks/v1 of each environment. */
export const AppHooksV1 = definePlatformHooks('doric.app.hooks/v1', {
  onActivateHook: defineHook({ kind: 'observe', input: activation }),
  onDeactivateHook: defineHook({ kind: 'observe', input: activation }),
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

const scopeSchema = z
  .object({
    projectId: z.string().optional(),
    threadId: z.string().optional(),
    promptId: z.string().optional(),
    windowKey: z.string().optional(),
  })
  .strict();

export const logRecordSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    fields: z.record(z.string(), z.unknown()).optional(),
    bundleId: z.string(),
    version: z.string(),
    generation: z.number().int(),
    environment: environmentSchema,
    scope: scopeSchema.optional(),
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

export interface DoricWindows {
  open(request: OpenWindowRequest, call?: CallArg): Promise<void>;
  focusOrOpen(key: string, call?: CallArg): Promise<void>;
}

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

export const DoricCatalogV1 = ref<DoricCatalog>('doric.catalog/v1');
export const DoricDiagnosticsV1 = ref<DoricDiagnostics>('doric.diagnostics/v1');
export const DoricBundleV1 = ref<DoricBundle>('doric.bundle/v1');
export const DoricLogV1 = ref<DoricLog>('doric.log/v1');
export const DoricWindowsV1 = ref<DoricWindows>('doric.windows/v1');
export const DoricMenusV1 = ref<DoricMenus>('doric.menus/v1');
export const DoricCacheV1 = ref<DoricCache>('doric.cache/v1');
export const DoricTokensV1 = ref<DoricTokens>('doric.tokens/v1');

const noInput = z.tuple([]);

export interface PlatformContractSpec {
  readonly environments: readonly Environment[];
  readonly methods: MethodSpecs;
}

/** Method specifications of the `doric.*` services, by contract ID. */
export const platformContracts = Object.freeze({
  'doric.catalog/v1': {
    environments: ['host'],
    methods: { get: { input: noInput, output: catalogSnapshotSchema } },
  },
  'doric.diagnostics/v1': {
    environments: ['host'],
    methods: {
      get: { input: noInput, output: diagnosticsSchema },
      report: { input: diagnosticReportSchema, output: z.void() },
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
  'doric.tokens/v1': {
    environments: ['client', 'desktopMain'],
    methods: {
      get: { input: noInput, output: z.record(z.string(), z.string()) },
    },
  },
} satisfies Record<string, PlatformContractSpec>);

export type PlatformContractId = keyof typeof platformContracts;
