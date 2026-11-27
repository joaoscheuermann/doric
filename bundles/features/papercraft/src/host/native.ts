// The packages with native code (spec "Native code", S57 D4): esbuild and the
// Tailwind compiler with its scanner, loaded through one CommonJS loader so no
// host module keeps a value `import()` of them.

import { createRequire } from 'node:module';

/** The esbuild API `papercraft` uses. */
export interface EsbuildApi {
  readonly build: typeof import('esbuild').build;
  readonly version: string;
}

/** The Tailwind compiler and its scanner. */
export interface TailwindApi {
  readonly compile: typeof import('tailwindcss').compile;
  readonly Scanner: typeof import('@tailwindcss/oxide').Scanner;
}

/**
 * The packages with native code (spec "Native code"). Each method loads on its first call (then the loader's cache)
 * and throws what the loader throws (`MODULE_NOT_FOUND` for a package it cannot resolve); callers are async, so a
 * throw is their rejection, as today's `import()` rejected.
 */
export interface NativePackages {
  esbuild(): EsbuildApi;
  tailwind(): TailwindApi;
}

/** `NativePackages` over a CommonJS loader (`context.assets.require` in the process). Creating it loads nothing. */
export const nativeOf = (
  load: (specifier: string) => unknown,
): NativePackages => ({
  esbuild: () => {
    const { build, version } = load('esbuild') as EsbuildApi;
    return { build, version };
  },
  tailwind: () => {
    const { compile } = load('tailwindcss') as Pick<TailwindApi, 'compile'>;
    const { Scanner } = load('@tailwindcss/oxide') as Pick<
      TailwindApi,
      'Scanner'
    >;
    return { compile, Scanner };
  },
});

/** `nativeOf(createRequire(import.meta.url))`: the default when no `native` is given. Loads nothing at import. */
export const moduleNative: NativePackages = nativeOf(
  createRequire(import.meta.url),
);
