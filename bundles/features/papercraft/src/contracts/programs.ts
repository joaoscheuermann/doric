// `papercraft.programs/v1@1.0.0` (host, D14): the library a papercraft fence
// is bound to (D10), one export or story of a workspace file (D16), and the
// bytes of a module the host memo holds. A window reaches all three over the
// bridge (`expose: 'desktop'`), scoped by `projectId` and `threadId` (the
// manifest's `desktopScope`). A papercraft fence's errors do not go here: they
// go to `openui.programs/v1` with the tag `papercraft`.

import { type CallArg, type MethodSpecs, ref } from 'bundle/contracts';
import { z } from 'zod';

/** D14's `ModuleRef`: one built module, as its cache directory and its files. */
export interface ModuleRef {
  /**
   * The cache directory: the SHA-256 of the files' `<path>:<sha256>` lines,
   * sorted by path and joined by `\n`. Equal files always give the same `dir`.
   */
  readonly dir: string;
  /**
   * `index.js`; `index.css` when the module has a sheet; and
   * `assets/<sha256>.<ext>` for each `url()` asset the sheet names.
   */
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

/**
 * D14's answer to `library`: `none` when the fence is bound to no working
 * directory or the walk from it found no library root; `ready` with the root
 * and its module; `failed` with the reason, and the root when one was found.
 */
export type LibraryAnswer =
  | { readonly status: 'none' }
  | {
      readonly status: 'ready';
      readonly root: string;
      readonly module: ModuleRef;
    }
  | {
      readonly status: 'failed';
      readonly root?: string;
      /** At most 4,096 characters. */
      readonly error: string;
    };

/** D16's answer to `export`: the built module, or why it did not build. */
export type ExportAnswer =
  | { readonly status: 'ready'; readonly module: ModuleRef }
  | { readonly status: 'failed'; readonly error: string };

/**
 * The answer to `read`: the bytes of one module's files. Each entry's `path`
 * is `<dir>/<file>`, as `papercraft.cache/v1.ensure` takes it, and its
 * `sha256` is that of the decoded `base64`.
 */
export interface ModuleEntries {
  readonly entries: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly base64: string;
  }[];
}

export const moduleRefSchema = z
  .object({
    dir: z.string(),
    files: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()),
  })
  .strict();

/** `library`'s input: the fence's `turnSequence`, an integer from 0. */
export const libraryInputSchema = z
  .object({ turnSequence: z.number().int().nonnegative() })
  .strict();

export const libraryAnswerSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }).strict(),
  z
    .object({
      status: z.literal('ready'),
      root: z.string(),
      module: moduleRefSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      root: z.string().optional(),
      error: z.string().max(4_096),
    })
    .strict(),
]);

/** `export`'s input: a workspace-relative `path` and the export's `name`. */
export const exportInputSchema = z
  .object({ path: z.string().min(1), name: z.string().min(1).optional() })
  .strict();

export const exportAnswerSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), module: moduleRefSchema }).strict(),
  z.object({ status: z.literal('failed'), error: z.string() }).strict(),
]);

export const readInputSchema = z.object({ dir: z.string().min(1) }).strict();

export const moduleEntriesSchema = z
  .object({
    entries: z.array(
      z
        .object({ path: z.string(), sha256: z.string(), base64: z.string() })
        .strict(),
    ),
  })
  .strict();

export interface PapercraftPrograms {
  /**
   * The library bound at `turnSequence` (D10): the root found from the `cwd`
   * of the Thread's last `papercraft.cwd/v1` event below `turnSequence`,
   * checked and built (D11–D14). Never rejects for a library problem: those
   * answer `failed`. Rejects with `invalid_input` for a bad input and
   * `invalid_scope` without a `projectId` and `threadId` in the call's scope.
   */
  library(
    input: { readonly turnSequence: number },
    call?: CallArg,
  ): Promise<LibraryAnswer>;
  /**
   * One export or story of a workspace file (D16), built through the preview
   * pipeline with the harness (D15). A path that leaves the Project, or a
   * source that does not build, answers `failed`.
   */
  export(
    input: { readonly path: string; readonly name?: string },
    call?: CallArg,
  ): Promise<ExportAnswer>;
  /**
   * The bytes of a module the memo holds. Throws ContractError `not_found`
   * when no memo key holds a module with that `dir`; the caller then asks
   * `library` or `export` again, once.
   */
  read(input: { readonly dir: string }, call?: CallArg): Promise<ModuleEntries>;
}

export const papercraftProgramsMethods = {
  library: {
    input: libraryInputSchema,
    output: libraryAnswerSchema,
    expose: 'desktop',
  },
  export: {
    input: exportInputSchema,
    output: exportAnswerSchema,
    expose: 'desktop',
  },
  read: {
    input: readInputSchema,
    output: moduleEntriesSchema,
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;

/** `papercraft.programs/v1`, as the `papercraft` bundle's host provides it. */
export const PapercraftProgramsV1 = ref<PapercraftPrograms>(
  'papercraft.programs/v1',
);
