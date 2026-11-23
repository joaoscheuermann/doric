import { type CallArg, ref } from './ref.js';

declare const handleBrand: unique symbol;

/** Opaque handle: its only member is a brand keyed by a `unique symbol`. */
export interface Handle {
  readonly [handleBrand]?: true;
}

export interface Fixture {
  /** Plain data in and out; the inventory has a row for it anyway. */
  list(input: { readonly prefix: string }, call?: CallArg): Promise<string[]>;
  /** A listener callback, with no inventory row. */
  watch(listener: (value: string) => void, call?: CallArg): Promise<void>;
  /** Answers a brand interface, with no inventory row. */
  open(input: { readonly name: string }, call?: CallArg): Promise<Handle>;
  /** Takes `any`, with no inventory row and not in the allowlist. */
  // biome-ignore lint/suspicious/noExplicitAny: the case under test
  loose(input: any, call?: CallArg): Promise<string>;
  /** Takes `any`, named by the allowlist, with no inventory row. */
  // biome-ignore lint/suspicious/noExplicitAny: the case under test
  allowed(input: any, call?: CallArg): Promise<string>;
  /** A listener callback, with an inventory row. */
  listed(listener: () => void, call?: CallArg): Promise<void>;
}

export const FixtureV1 = ref<Fixture>('fixture/v1');
