// A Project sandbox over a real directory (extracted from
// `tests/sandbox.test.ts`'s fake sandbox, D8/PC17/PC25): a temporary folder
// made a Git repository with the real `git init`, whose `putFile` and
// `getFile` act on its files and whose `exec` runs the command for real in
// it. `node` runs this process's Node on the given script, so a runner copy
// the host put there runs as the sandbox would run it; the esbuild path the
// host names (`SANDBOX_ESBUILD`, the sandbox image's) is mapped to this
// repository's esbuild, at the same version. `git` is the real one, found on
// `PATH`, which a workspace can prefix (PC25) or replace.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import type { RunnerSandbox } from '../../src/host/sandbox.js';
import {
  type LibraryOutput,
  type LibraryRunnerInput,
  libraryOutputSchema,
  type RunnerInput,
  type RunnerOutput,
  runnerOutputSchema,
  SANDBOX_ESBUILD,
} from '../../src/sandbox/protocol.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

/** This repository's esbuild, which stands for the sandbox image's. */
export const HOST_ESBUILD = require.resolve('esbuild');

/** The runner the bundle's build wrote (`project.json`'s `test` depends on `build`). */
export const RUNNER_URL = new URL(
  '../../../dist/sandbox/runner.mjs',
  import.meta.url,
);

/** The fixtures folder, in the sources (tsc does not copy it). */
export const FIXTURES = new URL('../../../tests/fixtures/', import.meta.url);

export interface ExecRecord {
  readonly cmd: readonly string[];
  readonly cwd?: string;
}

export interface DiskWorkspace {
  /** The workspace root, absolute. */
  readonly root: string;
  readonly sandbox: RunnerSandbox;
  /** Every `exec` the sandbox received, in order. */
  readonly execs: ExecRecord[];
  /** Every `putFile` path, in order. */
  readonly puts: string[];
  /** Makes the next `putFile` calls reject while `fail` returns true. */
  failPut(fail: (path: string) => boolean): void;
  /** Runs `git` in the root (the real one) and answers its stdout. */
  git(...args: string[]): Promise<string>;
  /** Writes one file under the root. */
  write(path: string, content: string): Promise<void>;
}

export interface DiskWorkspaceOptions {
  /** `git init` the root and commit `files` (default true). */
  readonly git?: boolean;
  /** A directory put before the inherited `PATH` of every command. */
  readonly pathPrefix?: string;
  /** Replaces `PATH` for every command but `node` itself. */
  readonly path?: string;
  /** `false`: the sandbox has no `node` (exit 127). */
  readonly node?: boolean;
}

const roots: string[] = [];

/** Removes every workspace made so far. */
export const removeWorkspaces = async (): Promise<void> => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const writeAll = async (
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

/** A workspace holding `files`, a Git repository with them committed by default. */
export const diskWorkspace = async (
  files: Readonly<Record<string, string>>,
  options: DiskWorkspaceOptions = {},
): Promise<DiskWorkspace> => {
  const root = await mkdtemp(join(tmpdir(), 'papercraft-disk-'));
  roots.push(root);
  await writeAll(root, files);

  const git = async (...args: string[]): Promise<string> =>
    (
      await run('git', args, {
        cwd: root,
        env: { ...process.env, ...GIT_ENV },
      })
    ).stdout;

  if (options.git !== false) {
    await git('init', '-q');
    await git('add', '-A');
    await git('commit', '-q', '--allow-empty', '-m', 'init');
  }

  const local = (path: string, cwd?: string): string =>
    isAbsolute(path) ? path : join(cwd ?? root, path);
  const execs: ExecRecord[] = [];
  const puts: string[] = [];
  let failPut: (path: string) => boolean = () => false;
  const envPath =
    options.path ??
    (options.pathPrefix === undefined
      ? (process.env.PATH ?? '')
      : `${options.pathPrefix}:${process.env.PATH ?? ''}`);

  const done = (exitCode: number, stdout = '', stderr = '') => ({
    exitCode,
    stdout,
    stderr,
    stdoutBytes: Buffer.from(stdout),
    stderrBytes: Buffer.from(stderr),
  });

  const spawned = (
    command: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number | undefined,
  ) =>
    new Promise<ReturnType<typeof done>>((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...GIT_ENV, PATH: envPath },
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        resolve(done(error.code === 'ENOENT' ? 127 : 1, stdout, String(error)));
      });
      child.on('close', (code) => {
        resolve(done(code ?? 1, stdout, stderr));
      });
    });

  const sandbox = {
    id: `disk:${root}:${randomUUID()}`,
    root,
    putFile: async (path: string, bytes: Uint8Array) => {
      puts.push(path);
      if (failPut(path)) throw new Error(`putFile refused ${path}`);
      await mkdir(dirname(local(path)), { recursive: true });
      await writeFile(local(path), bytes);
    },
    getFile: async (path: string) => await readFile(local(path)),
    exec: async ({
      cmd,
      cwd,
      timeoutMs,
    }: {
      readonly cmd: readonly string[];
      readonly cwd?: string;
      readonly timeoutMs?: number;
    }) => {
      execs.push({ cmd, ...(cwd === undefined ? {} : { cwd }) });
      const [command = '', ...args] = cmd;
      const at = cwd ?? root;

      if (command === 'node') {
        if (options.node === false) return done(127);
        const [, inputPath] = args;
        if (inputPath !== undefined) {
          const file = local(inputPath, at);
          const input = JSON.parse(await readFile(file, 'utf8')) as {
            esbuild?: string;
          };
          if (input.esbuild === SANDBOX_ESBUILD) {
            await writeFile(
              file,
              JSON.stringify({ ...input, esbuild: HOST_ESBUILD }),
            );
          }
        }
        return await spawned(process.execPath, args, at, timeoutMs);
      }

      return await spawned(command, args, at, timeoutMs);
    },
  } as unknown as RunnerSandbox;

  return {
    root,
    sandbox,
    execs,
    puts,
    failPut: (fail) => {
      failPut = fail;
    },
    git,
    write: async (path, content) => {
      await writeAll(root, { [path]: content });
    },
  };
};

/**
 * The files of one fixture folder under `tests/fixtures/`, by workspace path
 * under `prefix`. The fixture's `schemas/` lands in `.doric/papercraft/schemas/`
 * (this repository's `.gitignore` ignores `.doric`); its README is left out.
 */
export const fixtureFiles = async (
  name: string,
  prefix = '',
): Promise<Record<string, string>> => {
  const scratch = await mkdtemp(join(tmpdir(), 'papercraft-fixture-'));
  roots.push(scratch);
  await cp(new URL(`${name}/`, FIXTURES), scratch, { recursive: true });
  const listed = (
    await run('find', ['.', '-type', 'f'], { cwd: scratch })
  ).stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^\.\//u, ''));
  const files: Record<string, string> = {};

  for (const path of listed) {
    if (path === 'README.md') continue;
    const target = path.startsWith('schemas/')
      ? `.doric/papercraft/${path}`
      : path;
    files[`${prefix}${target}`] = await readFile(join(scratch, path), 'utf8');
  }

  return files;
};

/** The esbuild version of the host, which the runner must match. */
export const hostEsbuildVersion = async (): Promise<string> =>
  (await import('esbuild')).version;

/** Runs one job with the built runner in `workspace`, as the host would. */
const runJob = async (
  workspace: DiskWorkspace,
  input: Record<string, unknown>,
): Promise<{ readonly output: unknown; readonly stderr: string }> => {
  const runner = `${workspace.root}/.doric/papercraft/runner-test.mjs`;
  const job = `${workspace.root}/.doric/papercraft/jobs/${randomUUID()}`;
  await mkdir(dirname(runner), { recursive: true });
  await writeFile(runner, await readFile(RUNNER_URL));
  await mkdir(job, { recursive: true });
  await writeFile(
    `${job}/input.json`,
    JSON.stringify({
      esbuild: SANDBOX_ESBUILD,
      version: await hostEsbuildVersion(),
      windowUnserved: [],
      ...input,
    }),
  );

  try {
    const result = await workspace.sandbox.exec({
      cmd: ['node', runner, `${job}/input.json`, `${job}/output.json`],
      cwd: workspace.root,
      timeoutMs: 120_000,
    });
    const text = await readFile(`${job}/output.json`, 'utf8').catch(
      () => undefined,
    );

    if (text === undefined) {
      throw new Error(
        `The runner wrote no output (exit ${String(result.exitCode)}): ${result.stderr.trim().split('\n').slice(-5).join('\n')}`,
      );
    }

    return { output: JSON.parse(text) as unknown, stderr: result.stderr };
  } finally {
    await rm(job, { recursive: true, force: true });
  }
};

/** One library job (D14) run by the built runner; its output, checked against the protocol. */
export const libraryJob = async (
  workspace: DiskWorkspace,
  input: Omit<
    LibraryRunnerInput,
    'kind' | 'esbuild' | 'version' | 'windowUnserved'
  > &
    Partial<Pick<LibraryRunnerInput, 'windowUnserved'>>,
): Promise<LibraryOutput> => {
  const { output } = await runJob(workspace, { kind: 'library', ...input });
  const parsed = libraryOutputSchema.safeParse(output);

  if (!parsed.success) {
    throw new Error(
      `The runner's answer is not a library output: ${JSON.stringify(output).slice(0, 600)}`,
    );
  }

  return parsed.data;
};

/** One bundle job (today's input, `kind` absent) run by the built runner. */
export const bundleJob = async (
  workspace: DiskWorkspace,
  input: Pick<RunnerInput, 'path'> & Partial<Pick<RunnerInput, 'entry'>>,
): Promise<RunnerOutput> => {
  const { output } = await runJob(workspace, { ...input });

  return runnerOutputSchema.parse(output);
};
