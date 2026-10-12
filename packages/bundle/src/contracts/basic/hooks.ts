import { z } from 'zod';

import type { Call, CallArg } from '../call.js';
import type { Cleanup, Disposable } from '../context.js';
import {
  type Decision,
  type HookDefinition,
  type HooksContract,
  ref,
} from '../define.js';
import {
  disposableSchema,
  functionSchema,
  hooksContractSchema,
  type MethodSpecs,
} from './common.js';

/** An observe handler returns nothing. */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` lets an observe handler end on any call whose result is discarded, which `undefined` would reject
type ObserveOutput = void;

export type HookOutput<H extends HookDefinition> = H['kind'] extends
  | 'observe'
  | 'sequence'
  ? ObserveOutput
  : H['kind'] extends 'transform'
    ? z.output<H['input']>
    : Decision;

export type HookHandler<H extends HookDefinition> = (
  input: z.output<H['input']>,
  call: Call,
) => HookOutput<H> | Promise<HookOutput<H>>;

/** A handler as the provider stores it, before narrowing by kind. */
export type AnyHookHandler = (input: unknown, call: Call) => unknown;

/** What `define(C)` returns to the owner: one `execute` per hook. */
export type HookHandle<C extends HooksContract> = {
  readonly [K in keyof C['hooks']]: {
    execute(
      input: z.input<C['hooks'][K]['input']>,
      call?: CallArg,
    ): Promise<HookOutput<C['hooks'][K]>>;
  };
};

/** What `use(C)` returns to a consumer: one registration function per hook. */
export type HookRegistrar<C extends HooksContract> = {
  readonly [K in keyof C['hooks']]: (
    handler: HookHandler<C['hooks'][K]>,
  ) => Disposable;
};

/** What `services.use(HooksV1)` returns; the runtime builds it over the provider. */
export interface Hooks {
  define<C extends HooksContract>(contract: C): HookHandle<C>;
  use<C extends HooksContract>(contract: C): HookRegistrar<C>;
  whenAvailable<C extends HooksContract>(
    contract: C,
    // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
    callback: (registrar: HookRegistrar<C>) => void | Cleanup,
  ): Disposable;
}

/**
 * What a `hooks/v1` provider implements. `call.caller` identifies the owner
 * (define, execute) or the registrant (register, whenDefined).
 */
export interface HooksProvider {
  define(contract: HooksContract, call?: CallArg): Disposable;
  register(
    contract: HooksContract,
    hook: string,
    handler: AnyHookHandler,
    call?: CallArg,
  ): Disposable;
  whenDefined(
    contract: HooksContract,
    // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
    callback: () => void | Cleanup,
    call?: CallArg,
  ): Disposable;
  execute(
    contract: HooksContract,
    hook: string,
    input: unknown,
    call?: CallArg,
  ): Promise<unknown>;
}

export const HooksV1 = ref<Hooks, HooksProvider>('hooks/v1');

export const hooksMethods = {
  define: { input: hooksContractSchema, output: disposableSchema },
  register: {
    input: z.tuple([
      hooksContractSchema,
      z.string(),
      functionSchema<AnyHookHandler>(),
    ]),
    output: disposableSchema,
  },
  whenDefined: {
    input: z.tuple([
      hooksContractSchema,
      // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
      functionSchema<() => void | Cleanup>(),
    ]),
    output: disposableSchema,
  },
  execute: {
    input: z.tuple([hooksContractSchema, z.string(), z.unknown()]),
    output: z.unknown(),
  },
} as const satisfies MethodSpecs;
