// Runs a component bundle inside the Project's sandbox, where its files are.
//
// The sandbox image installs esbuild (`.sandbox.Dockerfile`, under
// `/opt/doric/bundler`); the host brings the runner, `dist/sandbox/runner.mjs`
// — this bundle's own resolution code (`bundle.ts`) around a disk reader — and
// copies it into the workspace once per version. One bundle is then: the
// input JSON written into a job folder under `.doric/papercraft/`, one
// `node runner.mjs`, the output JSON read back, the folder removed.
//
// A sandbox that cannot run it (no lease, no `node`, no esbuild, another
// esbuild version) answers `unavailable`, and so does a runner that breaks
// (a crash, a timeout, an output it cannot read), with why: the host then
// bundles through `files/v1` instead (`compile.ts`). Only a source that does
// not bundle is a failure: the same `invalid_input` the host would throw.

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { type Call, ContractError, type Services } from 'bundle/contracts';
import { type LeaseTask, RuntimeLeaseV1 } from 'runtime/contracts';
import type { z } from 'zod';

import {
  type LibraryOutput,
  type LibraryRunnerInput,
  libraryOutputSchema,
  type RunnerInput,
  type RunnerJob,
  type RunnerOutput,
  runnerOutputSchema,
  SANDBOX_ESBUILD,
} from '../sandbox/protocol.js';
import type { BundledComponent } from './bundle.js';
import { ensureIgnoreFiles } from './ignore.js';

/** The part of a leased sandbox a bundle uses. */
export type RunnerSandbox = Pick<
  Parameters<LeaseTask<unknown>>[0],
  'id' | 'root' | 'exec' | 'putFile' | 'getFile'
>;

/** The runner script the host copies into the sandbox. */
export interface RunnerScript {
  readonly bytes: Uint8Array;
  /** Names the copy, so a new host version copies its own. */
  readonly hash: string;
}

/** One bundle the host asks of the sandbox. */
export type SandboxBundleRequest = Omit<RunnerInput, 'esbuild'>;

/** What the sandbox answered. */
export type SandboxBundle =
  | {
      readonly status: 'built';
      readonly bundled: BundledComponent;
      /** The stylesheets the bundle imports, as the sandbox read them. */
      readonly styles: ReadonlyMap<string, string>;
    }
  | { readonly status: 'failed'; readonly error: ContractError }
  | { readonly status: 'unavailable'; readonly reason: string };

/** Asks the sandbox for one bundle. */
export type SandboxBundler = (
  request: SandboxBundleRequest,
) => Promise<SandboxBundle>;

/** Where the runner and its jobs live, under the workspace root. */
const WORK_DIR = '.doric/papercraft';

/** The longest one bundle or library job may run in the sandbox (D14). */
export const RUNNER_TIMEOUT_MS = 120_000;

/** The largest output the host reads back from one bundle. */
export const MAX_RUNNER_OUTPUT_BYTES = 64 * 1_048_576;

/** A shell's "command not found". */
const NOT_FOUND = 127;

/** The sandboxes found unable to bundle, and why: an image does not change. */
const unable = new Map<string, string>();

const tail = (text: string): string =>
  text.trim().split('\n').slice(-5).join('\n');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What one runner job answered: its output JSON, or why there is none. */
type JobOutcome =
  | { readonly status: 'output'; readonly json: unknown }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * Runs one job of `runner` in `sandbox`: the ignore files first (D8), then
 * the input written into a job folder, one `node runner.mjs` within the
 * 120 s timeout, the output read back, the folder removed.
 */
const runJob = async (
  sandbox: RunnerSandbox,
  input: RunnerJob,
  runner: RunnerScript,
  projectId: string,
): Promise<JobOutcome> => {
  const known = unable.get(sandbox.id);
  if (known !== undefined) return { status: 'unavailable', reason: known };

  const root = sandbox.root.replace(/\/+$/u, '');
  const runnerPath = `${root}/${WORK_DIR}/runner-${runner.hash}.mjs`;
  const job = `${root}/${WORK_DIR}/jobs/${randomUUID()}`;

  await ensureIgnoreFiles(sandbox, root, projectId);

  try {
    const present = await sandbox.exec({ cmd: ['test', '-f', runnerPath] });
    if (present.exitCode !== 0) await sandbox.putFile(runnerPath, runner.bytes);

    await sandbox.putFile(
      `${job}/input.json`,
      Buffer.from(JSON.stringify(input), 'utf8'),
    );

    const run = await sandbox.exec({
      cmd: ['node', runnerPath, `${job}/input.json`, `${job}/output.json`],
      cwd: root,
      timeoutMs: RUNNER_TIMEOUT_MS,
    });

    if (run.exitCode === NOT_FOUND) {
      const reason = 'the sandbox has no `node`';
      unable.set(sandbox.id, reason);

      return { status: 'unavailable', reason };
    }

    if (run.exitCode !== 0) {
      return {
        status: 'unavailable',
        reason: `the runner exited with ${String(run.exitCode)}: ${tail(run.stderr)}`,
      };
    }

    const bytes = await sandbox.getFile(`${job}/output.json`);

    if (bytes.byteLength > MAX_RUNNER_OUTPUT_BYTES) {
      return {
        status: 'unavailable',
        reason: `the runner's output is larger than ${String(MAX_RUNNER_OUTPUT_BYTES)} bytes`,
      };
    }

    return {
      status: 'output',
      json: JSON.parse(Buffer.from(bytes).toString('utf8')),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `the sandbox could not run the bundle: ${messageOf(error)}`,
    };
  } finally {
    await sandbox
      .exec({ cmd: ['rm', '-rf', '--', job] })
      .catch(() => undefined);
  }
};

/**
 * The runner's output of one job, checked by `schema`; why not, when it is
 * not. A runner that answers `unavailable` (no esbuild, another version) marks
 * the sandbox unable: an image does not change.
 */
const outputOf = <T extends { readonly status: string }>(
  sandbox: RunnerSandbox,
  outcome: JobOutcome,
  schema: z.ZodType<T>,
  what: string,
): T | { readonly status: 'unavailable'; readonly reason: string } => {
  if (outcome.status === 'unavailable') return outcome;

  const parsed = schema.safeParse(outcome.json);

  if (!parsed.success) {
    return {
      status: 'unavailable',
      reason: `the runner's output is not ${what}`,
    };
  }

  const output = parsed.data;

  if (
    output.status === 'unavailable' &&
    'reason' in output &&
    typeof output.reason === 'string'
  ) {
    unable.set(sandbox.id, output.reason);
  }

  return output;
};

/** Runs one bundle job (`kind` absent) in `sandbox` and answers its output. */
export const bundleOutputInSandbox = async (
  sandbox: RunnerSandbox,
  input: RunnerInput,
  runner: RunnerScript,
  projectId: string,
): Promise<RunnerOutput> =>
  outputOf(
    sandbox,
    await runJob(sandbox, input, runner, projectId),
    runnerOutputSchema,
    'a bundle answer',
  );

/** Runs one library job (D14) in `sandbox` and answers its output. */
export const libraryInSandbox = async (
  sandbox: RunnerSandbox,
  input: LibraryRunnerInput,
  runner: RunnerScript,
  projectId: string,
): Promise<LibraryOutput> =>
  outputOf(
    sandbox,
    await runJob(sandbox, input, runner, projectId),
    libraryOutputSchema,
    'a library answer',
  );

/** Bundles `request.path` in `sandbox` with `runner`. */
export const bundleInSandbox = async (
  sandbox: RunnerSandbox,
  request: SandboxBundleRequest,
  runner: RunnerScript,
): Promise<SandboxBundle> =>
  sandboxBundleOf(
    await bundleOutputInSandbox(
      sandbox,
      { ...request, esbuild: SANDBOX_ESBUILD },
      runner,
      sandbox.id,
    ),
  );

/** What a bundle job's output means to the preview pipeline. */
export const sandboxBundleOf = (output: RunnerOutput): SandboxBundle => {
  if (output.status === 'unavailable') return output;

  if (output.status === 'failed') {
    return {
      status: 'failed',
      error: new ContractError(output.code, output.message, output.details),
    };
  }

  return {
    status: 'built',
    bundled: {
      js: output.js,
      exportName: output.exportName,
      ...(output.harness === undefined ? {} : { harness: output.harness }),
      sources: new Map(Object.entries(output.sources)),
      globalCss: output.globalCss,
      componentCss: output.componentCss,
      windowSpecifiers: output.windowSpecifiers,
      hostSpecifiers: output.hostSpecifiers,
      warnings: output.warnings,
    },
    styles: new Map(Object.entries(output.styles)),
  };
};

let defaultRunner: Promise<RunnerScript | undefined> | undefined;

/** The runner this host's build wrote; `undefined` in a build without one. */
const loadRunner = (): Promise<RunnerScript | undefined> => {
  defaultRunner ??= readFile(new URL('../sandbox/runner.mjs', import.meta.url))
    .then((bytes) => ({
      bytes,
      hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    }))
    .catch(() => undefined);

  return defaultRunner;
};

/**
 * The bundler of the Project `call` is scoped to, over its current lease
 * (`runtime.lease/v1.withLease`, which never acquires one).
 */
export const sandboxBundler =
  (
    services: Services,
    call: Call,
    runner: () => Promise<RunnerScript | undefined> = loadRunner,
  ): SandboxBundler =>
  async (request) => {
    const script = await runner();

    if (script === undefined) {
      return {
        status: 'unavailable',
        reason: 'this host was built without the sandbox runner',
      };
    }

    const outcome = await services
      .use(RuntimeLeaseV1, call.scope)
      .withLease((sandbox) => bundleInSandbox(sandbox, request, script), call);

    return outcome.status === 'ready'
      ? outcome.value
      : {
          status: 'unavailable',
          reason: `the Project has no sandbox lease (${outcome.status})`,
        };
  };

/** One job as `papercraft.programs/v1` asks it: the runner's input without its esbuild fields. */
export type SandboxJob =
  | Omit<LibraryRunnerInput, 'esbuild' | 'version'>
  | Omit<RunnerInput, 'esbuild' | 'version'>;

/**
 * Runs jobs in the sandbox of a Project, over its current lease
 * (`runtime.lease/v1.withLease`, which never acquires one): `ProgramsDeps.runJob`.
 * No lease answers `unavailable` with "the Project has no sandbox lease".
 */
export const sandboxJobRunner =
  (
    services: Services,
    runner: () => Promise<RunnerScript | undefined> = loadRunner,
  ) =>
  async (
    projectId: string,
    job: SandboxJob,
  ): Promise<LibraryOutput | RunnerOutput> => {
    const script = await runner();

    if (script === undefined) {
      return {
        status: 'unavailable',
        reason: 'this host was built without the sandbox runner',
      };
    }

    const { version } = await import('esbuild');
    const outcome = await services
      .use(RuntimeLeaseV1, { projectId })
      .withLease(
        (sandbox): Promise<LibraryOutput | RunnerOutput> =>
          job.kind === 'library'
            ? libraryInSandbox(
                sandbox,
                { ...job, esbuild: SANDBOX_ESBUILD, version },
                script,
                projectId,
              )
            : bundleOutputInSandbox(
                sandbox,
                { ...job, esbuild: SANDBOX_ESBUILD, version },
                script,
                projectId,
              ),
      );

    return outcome.status === 'ready'
      ? outcome.value
      : {
          status: 'unavailable',
          reason: `the Project has no sandbox lease (${outcome.status})`,
        };
  };
