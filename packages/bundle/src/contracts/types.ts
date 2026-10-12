import type { z } from 'zod';

import type { CallArg } from './call.js';
import type {
  CommandDefinition,
  MethodDefinition,
  ServiceDefinition,
} from './define.js';
import type { ContractId } from './ids.js';
import type { Registrable } from './registrable.js';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/** Type-only key of the phantom API carried by a ref; it has no runtime value. */
export declare const refTypes: unique symbol;

/** Type-only key marking an implementation taken from a service definition. */
export declare const definitionMethods: unique symbol;

/** A ref holds only the contract ID at runtime; its type parameters carry the API. */
export interface ServiceRef<
  Api = unknown,
  Impl = Api,
  Id extends ContractId = ContractId,
> {
  readonly kind: 'ref';
  readonly id: Id;
  readonly [refTypes]?: { readonly api: Api; readonly impl: Impl };
}

export type AnyServiceRef = ServiceRef<unknown, unknown, ContractId>;

export type ApiOf<R extends AnyServiceRef> = NonNullable<
  R[typeof refTypes]
>['api'];

export type ImplOf<R extends AnyServiceRef> = NonNullable<
  R[typeof refTypes]
>['impl'];

export type RefId<R extends AnyServiceRef> = R['id'];

/** Dispatch handle of a command ref, used by `commands/v1.execute`. */
export interface CommandApi<
  Id extends ContractId = ContractId,
  I extends z.ZodType = z.ZodType,
> {
  readonly id?: Id;
  readonly input?: z.input<I>;
}

type StubResult<O extends z.ZodType, R> =
  R extends PromiseLike<unknown> ? Promise<z.output<O>> : z.output<O>;

/** The consumer stub of one method definition. */
export type StubOf<D> =
  D extends MethodDefinition<infer I, infer O, infer R>
    ? I extends z.ZodTuple
      ? (...args: [...z.input<I>, CallArg?]) => StubResult<O, R>
      : (input: z.input<I>, call?: CallArg) => StubResult<O, R>
    : never;

export type StubsOf<M> = { readonly [K in keyof M]: StubOf<M[K]> };

/** The API a ref exposes, derived from a definition or taken from an interface. */
export type ApiFrom<T> =
  T extends ServiceDefinition<ContractId, infer M>
    ? StubsOf<M>
    : T extends CommandDefinition<infer Id, infer I>
      ? CommandApi<Id, I>
      : T;

export interface DefinitionImpl<M> {
  readonly [definitionMethods]: M;
}

export type ImplFrom<T> =
  T extends ServiceDefinition<ContractId, infer M> ? DefinitionImpl<M> : T;

/** Removes a trailing optional `CallArg` parameter, keeping labels and optionals. */
export type StripCallArg<P extends readonly unknown[]> = P extends readonly [
  ...infer H,
  (infer L)?,
]
  ? [CallArg] extends [NonNullable<L>]
    ? H
    : P
  : P;

type Bound<T> = T extends Registrable<infer B> ? B : T;

type BindAll<P extends readonly unknown[]> = { [K in keyof P]: Bound<P[K]> };

/** The execute input a provider receives for an interface method. */
export type MethodInputOf<P extends readonly unknown[]> =
  StripCallArg<P> extends readonly [infer Only]
    ? Bound<Only>
    : BindAll<StripCallArg<P>>;

type InterfaceImplementation<I> = {
  readonly [K in keyof I]: I[K] extends (...args: infer P) => infer Ret
    ? MethodDefinition<z.ZodType<MethodInputOf<P>>, z.ZodType, Ret>
    : never;
};

/** What `defineService(ref, methods)` must provide for that ref. */
export type ImplementationOf<R extends AnyServiceRef> =
  ImplOf<R> extends DefinitionImpl<infer M>
    ? { readonly [K in keyof M]: MethodDefinition }
    : InterfaceImplementation<ImplOf<R>>;
