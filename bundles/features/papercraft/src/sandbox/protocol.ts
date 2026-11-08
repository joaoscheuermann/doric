// What the host and the sandbox runner exchange for one bundle: the host
// writes the input as JSON into the workspace, runs the runner on it, and
// reads the output JSON back. Files, not stdout: a sandbox command's output
// is capped well below what a module and its sources weigh.

import { z } from 'zod';

/** The esbuild the sandbox image installs (`.sandbox.Dockerfile`). */
export const SANDBOX_ESBUILD =
  '/opt/doric/bundler/node_modules/esbuild/lib/main.js';

/** One bundle the host asks of the runner. */
export interface RunnerInput {
  /** `bundle`, or absent: a job without `kind` is a bundle (1.2.0's input). */
  readonly kind?: 'bundle';
  /** The esbuild module the runner loads, and the version it must be. */
  readonly esbuild: string;
  readonly version: string;
  /** The Project path of the source, relative to the workspace root. */
  readonly path: string;
  readonly entry?: string;
  /** `WINDOW_PACKAGES` specifiers the window does not serve: bundle them. */
  readonly windowUnserved: readonly string[];
}

export const runnerOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('built'),
    js: z.string(),
    exportName: z.string(),
    harness: z.string().optional(),
    sources: z.record(z.string(), z.string()),
    globalCss: z.array(z.string()),
    componentCss: z.array(z.string()),
    /** The stylesheets above, read where the bundle ran. */
    styles: z.record(z.string(), z.string()),
    windowSpecifiers: z.array(z.string()),
    hostSpecifiers: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  /** The source does not bundle: the error the host compile would throw. */
  z.object({
    status: z.literal('failed'),
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  /** The sandbox cannot bundle (no esbuild, or another version). */
  z.object({ status: z.literal('unavailable'), reason: z.string() }),
]);

export type RunnerOutput = z.infer<typeof runnerOutputSchema>;

/* The library job (D10–D14) ------------------------------------------------ */

/**
 * D14's manifest: every Project path a job read, with the SHA-256 of its
 * bytes, or `null` when it was absent. A path ending in `/` is a directory:
 * its hash is that of its sorted entry names, joined by `\n`.
 */
export type Manifest = Readonly<Record<string, string | null>>;

/** One library job the host asks of the runner. */
export interface LibraryRunnerInput {
  readonly kind: 'library';
  readonly esbuild: string;
  readonly version: string;
  /** The working directory to walk up from (D10), absolute or workspace-relative. */
  readonly cwd: string;
  /**
   * The memo's last answer for the root last found from `cwd` (D14), its
   * manifest including the paths the host read for the sheet; when every path
   * hashes as listed, the runner answers `unchanged`.
   */
  readonly previous?: { readonly root: string; readonly manifest: Manifest };
  readonly windowUnserved: readonly string[];
}

/** One job of either kind: `kind` absent is a bundle. */
export type RunnerJob = RunnerInput | LibraryRunnerInput;

const manifestSchema = z.record(z.string(), z.string().nullable());

/** One repository component the library job found (D11, D12). */
export const libraryComponentSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** The signature lang-core's `toSpec()` gives, evaluated under Node. */
  signature: z.string(),
  /** The entry file, workspace-relative. */
  file: z.string(),
});

export type LibraryComponent = z.infer<typeof libraryComponentSchema>;

/**
 * What a library job answers. `ignoredBy` (on `built` and `failed`) is
 * `git check-ignore -v`'s rule that hides the root's `schemas/`, absent when
 * none does or Git did not answer in 5 s.
 */
export const libraryOutputSchema = z.discriminatedUnion('status', [
  /** No library root above the working directory, up to the repository root. */
  z.object({ status: z.literal('none') }),
  /** The root and every manifest path are as the previous answer had them. */
  z.object({ status: z.literal('unchanged'), root: z.string() }),
  z.object({
    status: z.literal('built'),
    /** The library root, absolute. */
    root: z.string(),
    js: z.string(),
    harness: z.string().optional(),
    components: z.array(libraryComponentSchema),
    sources: z.record(z.string(), z.string()),
    globalCss: z.array(z.string()),
    componentCss: z.array(z.string()),
    styles: z.record(z.string(), z.string()),
    windowSpecifiers: z.array(z.string()),
    hostSpecifiers: z.array(z.string()),
    warnings: z.array(z.string()),
    manifest: manifestSchema,
    ignoredBy: z.string().optional(),
  }),
  z.object({
    status: z.literal('failed'),
    root: z.string().optional(),
    error: z.string(),
    /** The entry files found before the failure. */
    entries: z.number().int().optional(),
    manifest: manifestSchema,
    ignoredBy: z.string().optional(),
  }),
  /** The sandbox cannot run the job (no esbuild, another version, no node). */
  z.object({ status: z.literal('unavailable'), reason: z.string() }),
]);

export type LibraryOutput = z.infer<typeof libraryOutputSchema>;
