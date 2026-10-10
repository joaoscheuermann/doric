import { z } from 'zod';

import type { Caller, CallScope, TraceContext } from '../../contracts/call.js';
import type { Cardinality } from '../../contracts/define.js';
import type { Environment } from '../../contracts/ids.js';
import {
  type CatalogSnapshot,
  catalogSnapshotSchema,
  type Diagnostics,
  diagnosticsSchema,
} from '../../contracts/platform.js';
import type { JsonObject } from '../../contracts/types.js';

/** The call metadata every envelope request carries for one hop. */
export interface WireCall {
  /** Filled by the sending dispatcher. */
  readonly caller: Caller;
  readonly scope?: CallScope;
  /** The hop span the sender created. */
  readonly trace: TraceContext;
  /** Epoch milliseconds; 0 means none. */
  readonly deadline: number;
  /** Operation generation the call chain is pinned to (0 = unpinned). */
  readonly generation: number;
}

/** A service call to a provider on the other side. */
export interface CallMessage extends WireCall {
  readonly kind: 'call';
  /** `${side}:${counter}`, unique per sending side. */
  readonly id: string;
  readonly contract: string;
  readonly method: string;
  /** Encoded input (local values replaced by wire forms). */
  readonly input: unknown;
  /** Bundle of the provider record the sender resolved (pinned or `many`). */
  readonly provider?: string;
  /**
   * The resolved record's key (`RemoteProviderDescriptor.key`), which tells
   * apart the records one bundle provides for a `many` contract.
   */
  readonly record?: string;
  /** No result is sent back (fire-and-forget methods such as `log/v1`). */
  readonly oneway?: true;
}

/** A call into a handle the other side exported (callback, tool, run). */
export interface InvokeMessage extends WireCall {
  readonly kind: 'invoke';
  readonly id: string;
  readonly handle: string;
  /** `execute` or `check` for tools, `run` for scoped callbacks; absent for callbacks. */
  readonly method?: string;
  /** Encoded arguments. */
  readonly args: readonly unknown[];
}

export type ResultMessage =
  | {
      readonly kind: 'result';
      readonly id: string;
      readonly ok: true;
      readonly output: unknown;
    }
  | {
      readonly kind: 'result';
      readonly id: string;
      readonly ok: false;
      readonly error: WireError;
    };

export interface CancelMessage {
  readonly kind: 'cancel';
  readonly id: string;
}

/** Releases a handle the receiver exported. */
export interface ReleaseMessage {
  readonly kind: 'release';
  readonly handle: string;
}

/**
 * Opens a stream (a `streamListener` method) across the desktop bridge or the
 * main <-> window IPC; the input carries no listener [S8-20]. The process
 * link between the kernel and a generation does not serve it: there the
 * listener crosses with the callback codec.
 */
export interface SubscribeMessage extends WireCall {
  readonly kind: 'subscribe';
  readonly id: string;
  readonly contract: string;
  readonly method: string;
  readonly input: unknown;
}

/** One stream item: `values` is `[item]` [S8-20]. */
export interface EventMessage {
  readonly kind: 'event';
  readonly id: string;
  readonly values: readonly unknown[];
}

/** The subscriber disposed its stream [S8-20]. */
export interface UnsubscribeMessage {
  readonly kind: 'unsubscribe';
  readonly id: string;
}

/**
 * The stream ended [S8-20]: by the provider (no error), by a failure, or by
 * the loss of the bridge (`disconnected`).
 */
export interface EndMessage {
  readonly kind: 'end';
  readonly id: string;
  readonly error?: WireError;
}

/** The app lifecycle hooks the desktop main process runs in a generation. */
export type AppLifecycleHook =
  | 'onAppReadyHook'
  | 'onAppActivateHook'
  | 'onBeforeQuitHook'
  | 'onGenerationReadyHook'
  | 'onConnectionChangedHook';

export const appLifecycleHooks: readonly AppLifecycleHook[] = Object.freeze([
  'onAppReadyHook',
  'onAppActivateHook',
  'onBeforeQuitHook',
  'onGenerationReadyHook',
  'onConnectionChangedHook',
]);

export type EnvelopeMessage =
  | CallMessage
  | InvokeMessage
  | ResultMessage
  | CancelMessage
  | ReleaseMessage
  | SubscribeMessage
  | EventMessage
  | UnsubscribeMessage
  | EndMessage;

/** How a thrown value crosses the envelope (see `errors.ts`). */
export interface WireError {
  /** `ContractError.code`, else `internal`; metadata only. */
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
  readonly thrown?: WireThrown;
}

export type WireThrown =
  | { readonly kind: 'value'; readonly value: unknown }
  | WireThrownError;

export interface WireThrownError {
  readonly kind: 'error';
  /** `Reflect.get(error, 'name')`. */
  readonly name: string;
  /** Constructor name, looked up in the receiver's class registry. */
  readonly prototype: string;
  /** Own properties in `getOwnPropertyNames` order, with enumerability. */
  readonly own: readonly WireOwnProperty[];
}

export type WireOwnProperty =
  | {
      readonly key: string;
      readonly enumerable: boolean;
      readonly value: unknown;
    }
  | {
      readonly key: string;
      readonly enumerable: boolean;
      /** An own property whose value is itself an error (such as `cause`). */
      readonly error: WireThrownError;
    };

/** A provider announced to the other side (`provide` control message). */
export interface RemoteProviderDescriptor {
  readonly contractId: string;
  readonly bundleId: string;
  /**
   * The record's identity in the announcing process: one bundle may provide
   * several records of a `many` contract (`models.provider/v1`), and each is
   * announced, called and withdrawn on its own.
   */
  readonly key?: string;
  /** Version of the providing bundle. */
  readonly version: string;
  readonly contractVersion: string;
  readonly environment: Environment;
  readonly cardinality: Cardinality;
  readonly schema:
    | { readonly kind: 'basic' }
    | { readonly kind: 'platform' }
    | { readonly kind: 'document'; readonly document: JsonObject };
}

/** Kernel <-> runner control plane; never routed to bundles. */
export type ControlMessage =
  /** Kernel -> child. `init` is the runner's `GenerationInit`; the runner validates it. */
  | { readonly kind: 'init'; readonly init: unknown }
  | { readonly kind: 'ready'; readonly order: readonly string[] }
  | {
      readonly kind: 'provide';
      readonly descriptor: RemoteProviderDescriptor;
    }
  | {
      readonly kind: 'unprovide';
      readonly contractId: string;
      readonly bundleId: string;
      /** The withdrawn record's key, when it was announced with one. */
      readonly key?: string;
    }
  | { readonly kind: 'diagnostics'; readonly snapshot: Diagnostics }
  | { readonly kind: 'catalog'; readonly snapshot: CatalogSnapshot }
  | {
      readonly kind: 'platform-log';
      readonly level: 'info' | 'warn' | 'error';
      readonly fields: Readonly<Record<string, unknown>>;
      readonly message: string;
    }
  /** Desktop main -> desktopMain generation: run one app lifecycle hook. */
  | {
      readonly kind: 'lifecycle';
      readonly id: string;
      readonly hook: AppLifecycleHook;
      readonly input: unknown;
    }
  /** Its answer: the hook's output (a `Decision` for `onBeforeQuitHook`). */
  | {
      readonly kind: 'lifecycle-result';
      readonly id: string;
      readonly ok: true;
      readonly output: unknown;
    }
  | {
      readonly kind: 'lifecycle-result';
      readonly id: string;
      readonly ok: false;
      readonly error: WireError;
    }
  | { readonly kind: 'stop' }
  | { readonly kind: 'stopped' };

export type WireMessage = EnvelopeMessage | ControlMessage;

export const controlKinds: ReadonlySet<string> = new Set([
  'init',
  'ready',
  'provide',
  'unprovide',
  'diagnostics',
  'catalog',
  'platform-log',
  'lifecycle',
  'lifecycle-result',
  'stop',
  'stopped',
]);

export const isControlMessage = (
  message: WireMessage,
): message is ControlMessage => controlKinds.has(message.kind);

// Schemas -------------------------------------------------------------------

const callerSchema = z.object({
  bundleId: z.string(),
  version: z.string(),
  generation: z.number(),
});

const scopeSchema = z.object({
  projectId: z.string().optional(),
  threadId: z.string().optional(),
  promptId: z.string().optional(),
  windowKey: z.string().optional(),
});

const wireCallShape = {
  caller: callerSchema,
  scope: scopeSchema.optional(),
  trace: z.object({ traceparent: z.string() }),
  deadline: z.number(),
  generation: z.number().int().nonnegative(),
};

const wireThrownErrorSchema: z.ZodType<WireThrownError> = z.lazy(() =>
  z.object({
    kind: z.literal('error'),
    name: z.string(),
    prototype: z.string(),
    own: z.array(
      z.union([
        z.object({
          key: z.string(),
          enumerable: z.boolean(),
          error: wireThrownErrorSchema,
        }),
        z.object({
          key: z.string(),
          enumerable: z.boolean(),
          value: z.unknown(),
        }),
      ]),
    ),
  }),
) as z.ZodType<WireThrownError>;

export const wireErrorSchema: z.ZodType<WireError> = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  thrown: z
    .union([
      z.object({ kind: z.literal('value'), value: z.unknown() }),
      wireThrownErrorSchema,
    ])
    .optional(),
}) as z.ZodType<WireError>;

export const remoteProviderDescriptorSchema: z.ZodType<RemoteProviderDescriptor> =
  z.object({
    contractId: z.string(),
    bundleId: z.string(),
    key: z.string().optional(),
    version: z.string(),
    contractVersion: z.string(),
    environment: z.enum(['host', 'desktopMain', 'client']),
    cardinality: z.enum(['one', 'many']),
    schema: z.union([
      z.object({ kind: z.literal('basic') }),
      z.object({ kind: z.literal('platform') }),
      z.object({
        kind: z.literal('document'),
        document: z.record(z.string(), z.unknown()),
      }),
    ]),
  }) as z.ZodType<RemoteProviderDescriptor>;

const idSchema = z.string().min(1);

/** Every message kind, validated on receipt before anything else reads it. */
export const wireMessageSchema: z.ZodType<WireMessage> = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('call'),
      id: idSchema,
      contract: z.string(),
      method: z.string(),
      input: z.unknown(),
      provider: z.string().optional(),
      record: z.string().optional(),
      oneway: z.literal(true).optional(),
      ...wireCallShape,
    }),
    z.object({
      kind: z.literal('invoke'),
      id: idSchema,
      handle: z.string(),
      method: z.string().optional(),
      args: z.array(z.unknown()),
      ...wireCallShape,
    }),
    z
      .object({
        kind: z.literal('result'),
        id: idSchema,
        ok: z.boolean(),
        output: z.unknown().optional(),
        error: wireErrorSchema.optional(),
      })
      .refine((message) => message.ok || message.error !== undefined),
    z.object({ kind: z.literal('cancel'), id: idSchema }),
    z.object({ kind: z.literal('release'), handle: z.string() }),
    z.object({
      kind: z.literal('subscribe'),
      id: idSchema,
      contract: z.string(),
      method: z.string(),
      input: z.unknown(),
      ...wireCallShape,
    }),
    z.object({
      kind: z.literal('event'),
      id: idSchema,
      values: z.array(z.unknown()),
    }),
    z.object({ kind: z.literal('unsubscribe'), id: idSchema }),
    z.object({
      kind: z.literal('end'),
      id: idSchema,
      error: wireErrorSchema.optional(),
    }),
    z.object({ kind: z.literal('init'), init: z.unknown() }),
    z.object({ kind: z.literal('ready'), order: z.array(z.string()) }),
    z.object({
      kind: z.literal('provide'),
      descriptor: remoteProviderDescriptorSchema,
    }),
    z.object({
      kind: z.literal('unprovide'),
      contractId: z.string(),
      bundleId: z.string(),
      key: z.string().optional(),
    }),
    z.object({ kind: z.literal('diagnostics'), snapshot: diagnosticsSchema }),
    z.object({ kind: z.literal('catalog'), snapshot: catalogSnapshotSchema }),
    z.object({
      kind: z.literal('platform-log'),
      level: z.enum(['info', 'warn', 'error']),
      fields: z.record(z.string(), z.unknown()),
      message: z.string(),
    }),
    z.object({
      kind: z.literal('lifecycle'),
      id: idSchema,
      hook: z.enum([
        'onAppReadyHook',
        'onAppActivateHook',
        'onBeforeQuitHook',
        'onGenerationReadyHook',
        'onConnectionChangedHook',
      ]),
      input: z.unknown(),
    }),
    z
      .object({
        kind: z.literal('lifecycle-result'),
        id: idSchema,
        ok: z.boolean(),
        output: z.unknown().optional(),
        error: wireErrorSchema.optional(),
      })
      .refine((message) => message.ok || message.error !== undefined),
    z.object({ kind: z.literal('stop') }),
    z.object({ kind: z.literal('stopped') }),
  ],
) as unknown as z.ZodType<WireMessage>;
