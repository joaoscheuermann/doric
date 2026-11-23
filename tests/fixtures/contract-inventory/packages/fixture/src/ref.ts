/** Stand-in for `@org/bundle`'s `ref`: a typed reference to a contract. */
export interface ServiceRef<T> {
  readonly kind: 'ref';
  readonly id: string;
  readonly api?: T;
}

export const ref = <T>(id: string): ServiceRef<T> => ({ kind: 'ref', id });

/** Stand-in for `CallArg`: the parameter named `call` is never inspected. */
export interface CallArg {
  readonly signal?: AbortSignal;
}
