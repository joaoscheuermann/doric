// `papercraft.cache/v1@1.0.0` (desktopMain, D14): the verified cache of the
// modules papercraft fences load. A window reads a module's entries from the
// host's `papercraft.programs/v1.read` and hands them to `ensure`, which writes
// each file only once its SHA-256 is confirmed; the protocol then serves what
// passed at `doric://app/papercraft-modules/<dir>/<file>`. The cache ignores
// the call's scope (`projectId`, `threadId`): its paths are content-addressed.

import { type CallArg, type MethodSpecs, ref } from 'bundle/contracts';
import { z } from 'zod';

/** Where the protocol serves the cache: `<MODULES_URL><dir>/<file>`. */
export const MODULES_URL = 'doric://app/papercraft-modules/';

/** One file as `ensure` takes it: `read`'s entry shape. */
export interface ModuleCacheEntry {
  /** `<dir>/<file>`: the module's `ModuleRef.dir` and one of its file paths. */
  readonly path: string;
  /** The SHA-256 of the decoded bytes, lowercase hex. */
  readonly sha256: string;
  /** The file's bytes, base64. */
  readonly base64: string;
}

/** What one `ensure` call left in the cache, by entry path. */
export interface ModuleCacheEnsureResult {
  /** Entries verified and written now. */
  readonly written: readonly string[];
  /** Entries already cached with the hash they declare. */
  readonly kept: readonly string[];
  /** Entries the cache refused (a bad path, a hash mismatch, a failed write). */
  readonly failed: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}

const moduleCacheEntrySchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    base64: z.string(),
  })
  .strict();

export const moduleCacheEnsureInputSchema = z
  .object({ entries: z.array(moduleCacheEntrySchema) })
  .strict();

export const moduleCacheEnsureResultSchema = z
  .object({
    written: z.array(z.string()),
    kept: z.array(z.string()),
    failed: z.array(
      z.object({ path: z.string(), message: z.string() }).strict(),
    ),
  })
  .strict();

export interface PapercraftCache {
  /**
   * Writes each entry whose bytes match its `sha256`, and refreshes the
   * modification time of each `<dir>/` it writes or keeps. Once per desktop
   * app session the first call cuts the cache back (above 256 MiB, oldest
   * directories first, to at most 128 MiB) before it writes, and every call
   * awaits that cut-back. A refused entry is listed in `failed`; the call
   * rejects only for an input that does not parse (`invalid_input`). Every
   * path listed in `written` or `kept` is served once the call resolves.
   */
  ensure(
    input: { readonly entries: readonly ModuleCacheEntry[] },
    call?: CallArg,
  ): Promise<ModuleCacheEnsureResult>;
}

export const papercraftCacheMethods = {
  ensure: {
    input: moduleCacheEnsureInputSchema,
    output: moduleCacheEnsureResultSchema,
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;

/** `papercraft.cache/v1`, as the `papercraft` bundle's desktop part provides it. */
export const PapercraftCacheV1 = ref<PapercraftCache>('papercraft.cache/v1');
