import { z } from 'zod';

import {
  isDisposable,
  isDisposableSchema,
  type MethodSpecs,
} from '../../contracts/basic/common.js';
import type { AnyHookHandler } from '../../contracts/basic/hooks.js';
import { basicContractSpec } from '../../contracts/basic/index.js';
import {
  type ContractTool,
  isContractTool,
  type ToolPayloadCheck,
} from '../../contracts/basic/tools.js';
import { type Call, isCall } from '../../contracts/call.js';
import type { Cleanup, Disposable } from '../../contracts/context.js';
import {
  defineEvent,
  defineHook,
  defineHooks,
  definePlatformHooks,
  defineSettings,
  defineStorageType,
  definitionKindOf,
  type EventDefinition,
  type HookDefinition,
  type HookKind,
  type HooksContract,
  isHooksContract,
  type SettingsDefinition,
  type StorageIndex,
  type StorageTypeDefinition,
} from '../../contracts/define.js';
import { ContractError } from '../../contracts/error.js';
import type { ContractId } from '../../contracts/ids.js';
import { isPlatformContract } from '../../contracts/ids.js';
import {
  AppHooksV1,
  platformContracts,
  WindowHooksV1,
} from '../../contracts/platform.js';
import type { JsonObject } from '../../contracts/types.js';
import { LOCAL_KEY, memberSchema, streamItemSchema } from '../json-schema.js';
import type { Principal } from '../principal.js';
import type { DisposalScope } from '../scope.js';
import { type SchemaValidators, validatorSchema } from './validators.js';

// Wire forms ----------------------------------------------------------------

/** The key every local value's wire form carries. */
export const WIRE_KEY = '$doric';

export type CallbackMode = 'async' | 'listener' | 'scoped';

export type WireValue =
  | { readonly $doric: 'call' }
  | {
      readonly $doric: 'callback';
      readonly handle: string;
      readonly mode: CallbackMode;
    }
  | { readonly $doric: 'disposable'; readonly handle: string }
  | { readonly $doric: 'object'; readonly handle: string }
  | {
      readonly $doric: 'hooks';
      readonly id: string;
      readonly hooks: Readonly<
        Record<string, { readonly kind: HookKind; readonly input: JsonObject }>
      >;
    }
  | {
      readonly $doric: 'definition';
      readonly kind: 'event' | 'settings' | 'storage-type';
      readonly id: string;
      readonly schema: JsonObject;
      readonly indexes?: readonly StorageIndex[];
    }
  | {
      readonly $doric: 'tool';
      readonly handle: string;
      readonly name: string;
      readonly description?: string;
      readonly definition: ContractTool['definition'];
      readonly settings: readonly object[];
    };

/** What a process exports behind a handle. */
export type ExportTarget =
  | {
      readonly kind: 'callback';
      readonly fn: (...args: unknown[]) => unknown;
      readonly mode: CallbackMode;
      /** Scoped callbacks: the principal and scope its runs register into. */
      readonly principal?: Principal;
      readonly parentScope?: DisposalScope;
    }
  | { readonly kind: 'disposable'; readonly value: Disposable }
  | { readonly kind: 'object'; readonly value: object }
  | { readonly kind: 'tool'; readonly tool: ContractTool };

/** The handle side of a link, as the value codecs see it. */
export interface CodecHost {
  readonly validators: SchemaValidators;
  exportHandle(target: ExportTarget): string;
  /** The target behind a handle this process exported, while it lives. */
  exported(handle: string): ExportTarget | undefined;
  invoke(
    handle: string,
    method: string | undefined,
    args: readonly unknown[],
    call: Call,
  ): Promise<unknown>;
  /** Starts one run of a scoped callback; returns the run handle. */
  run(handle: string, call: Call): string;
  release(handle: string): void;
  /** A call for invocations no caller call travels with (`doric`, new trace). */
  detachedCall(): Call;
  principalOf(bundleId: string): Principal | undefined;
  report(bundleId: string, kind: string, error: unknown): void;
  /** Per-link caches, so one wire form always yields one mirror. */
  readonly mirrors: Map<string, unknown>;
}

export interface CodecContext {
  readonly host: CodecHost;
  /** The call the value travels with; callbacks without a Call argument use it. */
  readonly call: Call;
  /** Handles exported while encoding (released with the operation). */
  readonly exports?: string[];
}

export type LocalKind =
  | 'callback'
  | 'disposable'
  | 'object'
  | 'call'
  | 'hooks'
  | 'definition'
  | 'tool';

/** Every local value a callback argument or result may carry. */
const anyKinds: ReadonlySet<LocalKind> = new Set<LocalKind>([
  'callback',
  'disposable',
  'object',
  'call',
  'hooks',
  'definition',
  'tool',
]);

// Encoding ------------------------------------------------------------------

const handleKey: unique symbol = Symbol('doric.envelope.handle');

/** A function marked with the callback mode it crosses with. */
class ModeCallback {
  constructor(
    readonly fn: (...args: unknown[]) => unknown,
    readonly mode: CallbackMode,
  ) {}
}

const localOnly = (what: string): ContractError =>
  new ContractError(
    'local_only',
    `${what} is local to its process and cannot cross the envelope.`,
  );

const isPlain = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value) as unknown;

  return prototype === Object.prototype || prototype === null;
};

const clonableBuiltins: readonly (abstract new (...args: never[]) => object)[] =
  [Date, RegExp, Map, Set, ArrayBuffer, Error];

const isClonableBuiltin = (value: object): boolean =>
  ArrayBuffer.isView(value) ||
  clonableBuiltins.some((type) => value instanceof type);

const hooksWire = (contract: HooksContract): WireValue => ({
  $doric: 'hooks',
  id: contract.id,
  hooks: Object.fromEntries(
    Object.entries(contract.hooks).map(([name, hook]) => [
      name,
      { kind: hook.kind, input: memberSchema(hook.input, 'input').schema },
    ]),
  ),
});

const definitionWire = (value: object): WireValue | undefined => {
  switch (definitionKindOf(value)) {
    case 'event': {
      const event = value as EventDefinition;

      return {
        $doric: 'definition',
        kind: 'event',
        id: event.type,
        schema: memberSchema(event.payload, 'input').schema,
      };
    }
    case 'settings': {
      const settings = value as SettingsDefinition;

      return {
        $doric: 'definition',
        kind: 'settings',
        id: settings.id,
        schema: memberSchema(settings.schema, 'input').schema,
      };
    }
    case 'storage-type': {
      const type = value as StorageTypeDefinition;

      return {
        $doric: 'definition',
        kind: 'storage-type',
        id: type.type,
        schema: memberSchema(type.schema, 'input').schema,
        indexes: type.indexes.map((index) => ({
          name: index.name,
          fields: [...index.fields],
          ...(index.unique === undefined ? {} : { unique: index.unique }),
        })),
      };
    }
    default:
      return undefined;
  }
};

/**
 * Replaces the local values a member may carry by their wire forms. A local
 * value of a kind the member does not allow is refused with `local_only`.
 */
export const encodeValue = (
  value: unknown,
  kinds: ReadonlySet<LocalKind>,
  context: CodecContext,
): unknown => {
  const exportHandle = (target: ExportTarget): string => {
    const handle = context.host.exportHandle(target);

    context.exports?.push(handle);

    return handle;
  };
  const visit = (current: unknown): unknown => {
    if (current instanceof ModeCallback) {
      if (!kinds.has('callback')) {
        throw localOnly('A function');
      }

      const principal =
        current.mode === 'scoped'
          ? context.host.principalOf(context.call.caller.bundleId)
          : undefined;

      return {
        $doric: 'callback',
        handle: exportHandle({
          kind: 'callback',
          fn: current.fn,
          mode: current.mode,
          ...(principal === undefined
            ? {}
            : { principal, parentScope: principal.current }),
        }),
        mode: current.mode,
      } satisfies WireValue;
    }

    if (typeof current === 'function') {
      return visit(
        new ModeCallback(current as (...args: unknown[]) => unknown, 'async'),
      );
    }

    if (typeof current !== 'object' || current === null) {
      return current;
    }

    const imported = (current as { [handleKey]?: WireValue })[handleKey];

    if (imported !== undefined) {
      return imported;
    }

    if (isCall(current)) {
      if (!kinds.has('call')) {
        throw localOnly('A call');
      }

      return { $doric: 'call' } satisfies WireValue;
    }

    if (isHooksContract(current)) {
      if (!kinds.has('hooks')) {
        throw localOnly('A hooks contract');
      }

      return hooksWire(current);
    }

    const definition = definitionWire(current);

    if (definition !== undefined) {
      if (!kinds.has('definition')) {
        throw localOnly('A definition');
      }

      return definition;
    }

    if (kinds.has('tool') && isContractTool(current)) {
      return {
        $doric: 'tool',
        handle: exportHandle({ kind: 'tool', tool: current }),
        name: current.name,
        ...(current.description === undefined
          ? {}
          : { description: current.description }),
        definition: current.definition,
        settings: current.settings,
      } satisfies WireValue;
    }

    if (Array.isArray(current)) {
      return current.map(visit);
    }

    if (kinds.has('disposable') && isDisposable(current)) {
      return {
        $doric: 'disposable',
        handle: exportHandle({ kind: 'disposable', value: current }),
      } satisfies WireValue;
    }

    if (isPlain(current)) {
      const copy: Record<string, unknown> = {};

      for (const key of Object.keys(current)) {
        copy[key] = visit((current as Record<string, unknown>)[key]);
      }

      return copy;
    }

    if (isClonableBuiltin(current)) {
      return current;
    }

    if (kinds.has('object')) {
      return {
        $doric: 'object',
        handle: exportHandle({ kind: 'object', value: current }),
      } satisfies WireValue;
    }

    return current;
  };

  return visit(value);
};

// Decoding ------------------------------------------------------------------

const isWire = (value: unknown): value is WireValue =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>)[WIRE_KEY] === 'string';

const remoteObject = (wire: WireValue): object =>
  new Proxy(Object.freeze(Object.create(null)) as object, {
    get: (_target, property) => {
      if (property === handleKey) {
        return wire;
      }

      if (
        typeof property === 'symbol' ||
        property === 'then' ||
        property === 'dispose' ||
        property === 'toJSON'
      ) {
        return undefined;
      }

      throw localOnly('An object of another process');
    },
  });

const tag = <T extends object>(value: T, wire: WireValue): T => {
  Object.defineProperty(value, handleKey, { value: wire });

  return value;
};

const callbackProxy = (
  wire: Extract<WireValue, { $doric: 'callback' }>,
  context: CodecContext,
): unknown => {
  const { host } = context;

  if (wire.mode === 'scoped') {
    return tag(() => {
      const run = host.run(wire.handle, context.call);

      return () => host.release(run);
    }, wire);
  }

  const invoke = (args: unknown[]): Promise<unknown> =>
    host.invoke(
      wire.handle,
      undefined,
      args,
      (args.find((arg) => isCall(arg)) as Call | undefined) ?? context.call,
    );

  if (wire.mode === 'listener') {
    return tag((...args: unknown[]) => {
      invoke(args).catch((error: unknown) =>
        host.report(context.call.caller.bundleId, 'listener_failed', error),
      );
    }, wire);
  }

  return tag((...args: unknown[]) => invoke(args), wire);
};

const remoteDisposable = (handle: string, host: CodecHost): Disposable => {
  let released = false;

  return Object.freeze({
    dispose: () => {
      if (!released) {
        released = true;
        host.release(handle);
      }
    },
  });
};

/** The JSON-Schema validator a mirror definition parses with. */
const mirrorSchema = (host: CodecHost, schema: JsonObject): z.ZodType =>
  validatorSchema(host.validators, schema);

const mirrorObject = (host: CodecHost, schema: JsonObject): z.ZodObject => {
  const check = host.validators.compile(schema);

  return z.looseObject({}).superRefine((value, context) => {
    for (const issue of check(value)) {
      context.addIssue({
        code: 'custom',
        message: issue.message,
        path: [...issue.path],
      });
    }
  });
};

const platformHooks: ReadonlyMap<string, HooksContract> = new Map<
  string,
  HooksContract
>([
  [AppHooksV1.id, AppHooksV1],
  [WindowHooksV1.id, WindowHooksV1],
]);

const cached = <T>(host: CodecHost, key: string, build: () => T): T => {
  if (host.mirrors.has(key)) {
    return host.mirrors.get(key) as T;
  }

  const value = build();

  host.mirrors.set(key, value);

  return value;
};

const hooksMirror = (
  wire: Extract<WireValue, { $doric: 'hooks' }>,
  host: CodecHost,
): HooksContract => {
  const platform = platformHooks.get(wire.id);

  if (platform !== undefined) {
    return platform;
  }

  return cached(host, `hooks:${JSON.stringify(wire)}`, () => {
    const hooks: Record<string, HookDefinition> = {};

    for (const [name, hook] of Object.entries(wire.hooks)) {
      hooks[name] = defineHook({
        kind: hook.kind,
        input: mirrorSchema(host, hook.input),
      });
    }

    return isPlatformContract(wire.id)
      ? definePlatformHooks(wire.id as ContractId, hooks)
      : defineHooks(wire.id as ContractId, hooks);
  });
};

const definitionMirror = (
  wire: Extract<WireValue, { $doric: 'definition' }>,
  host: CodecHost,
): object =>
  cached(host, `definition:${JSON.stringify(wire)}`, () => {
    switch (wire.kind) {
      case 'event':
        return defineEvent({
          type: wire.id as ContractId,
          payload: mirrorObject(host, wire.schema),
        });
      case 'settings':
        return defineSettings({
          id: wire.id as ContractId,
          schema: mirrorSchema(host, wire.schema),
        });
      case 'storage-type':
        return defineStorageType({
          type: wire.id as ContractId,
          schema: mirrorObject(host, wire.schema),
          indexes: wire.indexes ?? [],
        });
    }
  });

/** Rebuilds the local values of a decoded member; plain data is kept as sent. */
export const decodeValue = (value: unknown, context: CodecContext): unknown => {
  const { host } = context;
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) {
      return current.map(visit);
    }

    if (typeof current !== 'object' || current === null) {
      return current;
    }

    if (!isWire(current)) {
      if (!isPlain(current)) {
        return current;
      }

      const copy: Record<string, unknown> = {};

      for (const key of Object.keys(current)) {
        copy[key] = visit((current as Record<string, unknown>)[key]);
      }

      return copy;
    }

    switch (current.$doric) {
      case 'call':
        return context.call;
      case 'callback': {
        const home = host.exported(current.handle);

        return home?.kind === 'callback'
          ? home.fn
          : callbackProxy(current, context);
      }
      case 'disposable': {
        const home = host.exported(current.handle);

        return home?.kind === 'disposable'
          ? home.value
          : remoteDisposable(current.handle, host);
      }
      case 'object': {
        const home = host.exported(current.handle);

        return home?.kind === 'object' ? home.value : remoteObject(current);
      }
      case 'hooks':
        return hooksMirror(current, host);
      case 'definition':
        return definitionMirror(current, host);
      case 'tool': {
        const home = host.exported(current.handle);

        return home?.kind === 'tool'
          ? home.tool
          : new RemoteTool(current, host);
      }
      default:
        return current;
    }
  };

  return visit(value);
};

// Remote tools ----------------------------------------------------------------

/** What `toTool(call)` returns: the agent-loop tool of one prompt call. */
export interface RemoteToolCallView {
  readonly name: string;
  readonly description?: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodType;
  readonly definition: ContractTool['definition'];
  execute(payload: unknown): Promise<unknown>;
  check(payload: unknown): Promise<ToolPayloadCheck>;
}

/**
 * A tool registered in another process. Validation (`check`) and execution
 * run there with the tool's own schemas; `input` is a placeholder.
 */
export class RemoteTool implements ContractTool {
  readonly name: string;
  readonly description?: string;
  readonly input: z.ZodObject = z.looseObject({});
  readonly output: z.ZodType = z.unknown();
  readonly definition: ContractTool['definition'];
  readonly settings: readonly object[];
  readonly #handle: string;
  readonly #host: CodecHost;

  constructor(wire: Extract<WireValue, { $doric: 'tool' }>, host: CodecHost) {
    this.name = wire.name;

    if (wire.description !== undefined) {
      this.description = wire.description;
    }

    this.definition = wire.definition;
    this.settings = wire.settings;
    this.#handle = wire.handle;
    this.#host = host;
    tag(this, wire);
  }

  check(payload: unknown, call?: Call): Promise<ToolPayloadCheck> {
    return this.#host.invoke(
      this.#handle,
      'check',
      [payload],
      call ?? this.#host.detachedCall(),
    ) as Promise<ToolPayloadCheck>;
  }

  execute(payload: unknown, call: Call): Promise<unknown> {
    return this.#host.invoke(this.#handle, 'execute', [payload], call);
  }

  toTool(call: Call): RemoteToolCallView {
    return {
      name: this.name,
      ...(this.description === undefined
        ? {}
        : { description: this.description }),
      input: this.input,
      output: this.output,
      definition: this.definition,
      execute: (payload) => this.execute(payload, call),
      check: (payload) => this.check(payload, call),
    };
  }
}

/** Runs one handle invocation the other side sent. */
export const invokeExport = async (
  target: ExportTarget,
  method: string | undefined,
  args: readonly unknown[],
  call: Call,
): Promise<unknown> => {
  switch (target.kind) {
    case 'callback':
      return await target.fn(...args);
    case 'tool': {
      const { tool } = target;
      const [payload] = args;

      if (method === 'check') {
        if (tool.check !== undefined) {
          return await tool.check(payload);
        }

        const parsed = tool.input.safeParse(payload);

        return parsed.success
          ? { success: true, data: parsed.data }
          : {
              success: false,
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.map(String).join('.'),
                message: issue.message,
              })),
            };
      }

      if (method === 'execute') {
        return await tool.execute(payload, call);
      }

      throw new ContractError(
        'unavailable',
        `Tool "${tool.name}" has no method "${String(method)}".`,
      );
    }
    default:
      throw new ContractError('unavailable', 'This handle cannot be invoked.');
  }
};

// Method plans ----------------------------------------------------------------

/** How one method crosses the envelope. */
export interface MethodPlan {
  /** Why the method cannot cross (`local_only`), when it cannot. */
  readonly refused?: string;
  /** Fire-and-forget: no result is awaited, the stub returns undefined. */
  readonly oneway?: boolean;
  /** A synchronous registration: a local Disposable now, an acknowledgement later. */
  readonly optimistic?: boolean;
  /** Local kinds the input may carry; undefined = plain data. */
  readonly input?: ReadonlySet<LocalKind>;
  /** Local kinds the output may carry; undefined = plain data. */
  readonly output?: ReadonlySet<LocalKind>;
  /** Sender side, with the real definitions: before encoding the input. */
  prepare?(input: unknown): unknown;
  /** Sender side, with the real definitions: after decoding the output. */
  finish?(output: unknown, input: unknown): unknown;
}

const kinds = (...values: LocalKind[]): ReadonlySet<LocalKind> =>
  new Set(values);

const disposableOut = kinds('disposable');

const reparse = (schema: z.ZodType | undefined, value: unknown): unknown => {
  if (schema === undefined) {
    return value;
  }

  const parsed = schema.safeParse(value);

  return parsed.success ? parsed.data : value;
};

const definitionSchema = (definition: unknown): z.ZodType | undefined => {
  switch (definitionKindOf(definition)) {
    case 'event':
      return (definition as EventDefinition).payload;
    case 'settings':
      return (definition as SettingsDefinition).schema;
    case 'storage-type':
      return (definition as StorageTypeDefinition).schema;
    default:
      return undefined;
  }
};

const hookInput = (contract: unknown, hook: unknown): z.ZodType | undefined =>
  isHooksContract(contract) && typeof hook === 'string'
    ? contract.hooks[hook]?.input
    : undefined;

const reparseEntry = (definition: unknown, entry: unknown): unknown => {
  if (typeof entry !== 'object' || entry === null) {
    return entry;
  }

  return {
    ...entry,
    value: reparse(
      definitionSchema(definition),
      (entry as { value: unknown }).value,
    ),
  };
};

const oneway: MethodPlan = Object.freeze({ oneway: true });

/** Methods of basic contracts whose local values cross through a codec. */
const basicPlans: Readonly<
  Record<string, Readonly<Record<string, MethodPlan>>>
> = {
  'hooks/v1': {
    define: { input: kinds('hooks'), optimistic: true, output: disposableOut },
    register: {
      input: kinds('hooks', 'callback'),
      optimistic: true,
      output: disposableOut,
      // The registrant's handler receives its own schema's parse.
      prepare: (input) => {
        const [contract, hook, handler] = input as [
          HooksContract,
          string,
          AnyHookHandler,
        ];
        const schema = hookInput(contract, hook);

        return [
          contract,
          hook,
          (value: unknown, call: Call) => handler(reparse(schema, value), call),
        ];
      },
    },
    whenDefined: {
      input: kinds('hooks', 'callback'),
      optimistic: true,
      output: disposableOut,
      prepare: (input) => {
        const [contract, callback] = input as [
          HooksContract,
          () => undefined | Cleanup,
        ];

        return [
          contract,
          new ModeCallback(
            callback as (...args: unknown[]) => unknown,
            'scoped',
          ),
        ];
      },
    },
    execute: {
      input: kinds('hooks'),
      prepare: (input) => {
        const [contract, hook, value] = input as [
          HooksContract,
          string,
          unknown,
        ];

        return [contract, hook, reparse(hookInput(contract, hook), value)];
      },
      finish: (output, input) => {
        const [contract, hook] = input as [HooksContract, string];

        return isHooksContract(contract) &&
          contract.hooks[hook]?.kind === 'transform'
          ? reparse(hookInput(contract, hook), output)
          : output;
      },
    },
  },
  'log/v1': { debug: oneway, info: oneway, warn: oneway, error: oneway },
  'tools/v1': {
    register: { input: kinds('tool'), optimistic: true, output: disposableOut },
    // Tools cross as tool handles; back home they are the registered tool.
    list: { output: kinds('tool') },
  },
  'settings/v1': {
    register: {
      input: kinds('definition'),
      optimistic: true,
      output: disposableOut,
    },
    get: {
      input: kinds('definition'),
      finish: (output, input) => reparse(definitionSchema(input), output),
    },
    entry: {
      input: kinds('definition'),
      finish: (output, input) => reparseEntry(input, output),
    },
    set: {
      input: kinds('definition'),
      prepare: (input) => {
        const [definition, value, ...rest] = input as unknown[];

        return [
          definition,
          reparse(definitionSchema(definition), value),
          ...rest,
        ];
      },
      finish: (output, input) => reparseEntry((input as unknown[])[0], output),
    },
    subscribe: {
      input: kinds('definition', 'callback'),
      optimistic: true,
      output: disposableOut,
      prepare: (input) => {
        const [definition, listener] = input as [
          SettingsDefinition,
          (entry: unknown) => void,
        ];

        return [
          definition,
          new ModeCallback(
            (entry: unknown) => listener(reparseEntry(definition, entry)),
            'listener',
          ),
        ];
      },
    },
  },
  'secrets/v1': {
    registerReferences: { refused: 'secrets/v1 registerReferences' },
    view: { refused: 'secrets/v1 view' },
  },
  'storage/v1': {
    defineType: {
      input: kinds('definition'),
      optimistic: true,
      output: disposableOut,
    },
  },
  'events/v1': {
    register: {
      input: kinds('definition'),
      optimistic: true,
      output: disposableOut,
    },
    append: {
      input: kinds('definition'),
      prepare: (input) => {
        const [definition, payload] = input as [EventDefinition, unknown];

        return [definition, reparse(definitionSchema(definition), payload)];
      },
    },
  },
};

const platformOneway: ReadonlySet<string> = new Set([
  'doric.log/v1.write',
  'doric.diagnostics/v1.report',
]);

const plain: MethodPlan = Object.freeze({});

/** The plan of a basic or platform method without a codec entry. */
const defaultPlan = (
  label: string,
  spec: { readonly input: z.ZodType; readonly output: z.ZodType },
): MethodPlan => {
  const inputLocal = memberSchema(spec.input, 'input').local;
  const outputLocal = memberSchema(spec.output, 'output').local;

  if (!inputLocal && !outputLocal) {
    return plain;
  }

  if (!inputLocal && isDisposableSchema(spec.output)) {
    return { optimistic: true, output: disposableOut };
  }

  // Local values with a codec marker (`models/v1`) cross by their marker.
  return documentPlan(
    label,
    memberSchema(spec.input, 'input').schema,
    memberSchema(spec.output, 'output').schema,
  );
};

const markerKinds = (schema: unknown, found: Set<LocalKind>): boolean => {
  if (Array.isArray(schema)) {
    return schema.every((entry) => markerKinds(entry, found));
  }

  if (typeof schema !== 'object' || schema === null) {
    return true;
  }

  const marker = (schema as Record<string, unknown>)[LOCAL_KEY];

  if (marker === true) {
    return false;
  }

  if (marker === 'callback' || marker === 'disposable' || marker === 'object') {
    found.add(marker);
  }

  return Object.values(schema).every((entry) => markerKinds(entry, found));
};

/**
 * The plan of a bundle-defined method from its member schemas: local values
 * with a codec cross by their marker; a member with any value marked `true`
 * is refused.
 */
export const documentPlan = (
  label: string,
  input: unknown,
  output: unknown,
): MethodPlan => {
  const inputKinds = new Set<LocalKind>();
  const outputKinds = new Set<LocalKind>();

  if (!markerKinds(input, inputKinds) || !markerKinds(output, outputKinds)) {
    return { refused: label };
  }

  // [S8-20] A stream method returns its Disposable synchronously, like any
  // registration: the subscription is acknowledged later.
  if (
    streamItemSchema(input) !== undefined &&
    typeof output === 'object' &&
    output !== null &&
    (output as Record<string, unknown>)[LOCAL_KEY] === 'disposable'
  ) {
    return { input: inputKinds, optimistic: true, output: disposableOut };
  }

  return {
    ...(inputKinds.size === 0 ? {} : { input: inputKinds }),
    ...(outputKinds.size === 0 ? {} : { output: outputKinds }),
  };
};

const planCache = new Map<string, MethodPlan>();

/**
 * How a method of a basic or platform contract crosses. Undefined for a
 * bundle-defined contract: its plan comes from its member schemas.
 */
export const fixedPlan = (
  contractId: string,
  method: string,
): MethodPlan | undefined => {
  const key = `${contractId}.${method}`;
  const known = planCache.get(key);

  if (known !== undefined) {
    return known;
  }

  const basic = basicContractSpec(contractId);
  const platform = Object.hasOwn(platformContracts, contractId)
    ? platformContracts[contractId as keyof typeof platformContracts]
    : undefined;
  const methods: MethodSpecs | undefined = basic?.methods ?? platform?.methods;
  const spec = methods?.[method];

  if (spec === undefined) {
    return undefined;
  }

  const entry = basicPlans[contractId]?.[method];
  const plan =
    entry ??
    (platformOneway.has(key)
      ? oneway
      : defaultPlan(`${contractId} ${method}`, spec));

  planCache.set(key, plan);

  return plan;
};

/** The plan of any method, given the member schemas of its record. */
export const planFor = (
  contractId: string,
  method: string,
  members: { readonly input: z.ZodType; readonly output: z.ZodType },
): MethodPlan =>
  fixedPlan(contractId, method) ??
  documentPlan(
    `${contractId} ${method}`,
    memberSchema(members.input, 'input').schema,
    memberSchema(members.output, 'output').schema,
  );

export { anyKinds, localOnly };
