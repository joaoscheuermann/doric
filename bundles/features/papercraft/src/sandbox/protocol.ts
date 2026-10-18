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
