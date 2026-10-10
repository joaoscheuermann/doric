import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import { credentialKey } from './platform.js';

/*
 * The compiled host as an operator runs it: `node agents/doric/dist/src/index.js`
 * in its own process, configured only through its environment. Build doric
 * first. The cases read its JSON log file (`DORIC_LOG_FILE`), its exit code
 * and its HTTP surface, never its internals.
 */

const entrypoint = 'agents/doric/dist/src/index.js';
const migrations = 'bundles/postgres/prisma/migrations';

/** One record of the host's JSON log file. */
export interface LogLine {
  readonly level: number;
  readonly msg?: string;
  readonly component?: string;
  readonly stage?: string;
  readonly [field: string]: unknown;
}

export interface HostProcess {
  readonly url: string;
  readonly child: ChildProcess;
  /** Resolves with the exit code (or the signal name) once the host exits. */
  readonly exited: Promise<number | string>;
  /** Every record the host wrote to its log file so far. */
  lines(): Promise<readonly LogLine[]>;
  /** The raw log file and console output, for secret scans. */
  output(): Promise<string>;
  request(path: string, method?: string, body?: unknown): Promise<Response>;
  /** Sends SIGTERM and waits for the exit. */
  stop(): Promise<number | string>;
  /** Kills a host still running and removes its log directory. */
  close(): Promise<void>;
}

/** A free TCP port on 127.0.0.1. */
export const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
};

/** A fresh database on the test server with every migration `skip` does not name. */
export const freshDatabase = async (
  connectionString: string,
  options: { readonly skip?: (migration: string) => boolean } = {},
) => {
  const name = `doric_host_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  const sql = new pg.Client({ connectionString: url.toString() });
  try {
    await sql.connect();
    for (const entry of (await readdir(migrations))
      .filter((entry) => entry !== 'migration_lock.toml')
      .sort()) {
      if (options.skip?.(entry) === true) continue;
      await sql.query(
        await readFile(join(migrations, entry, 'migration.sql'), 'utf8'),
      );
    }
  } catch (error) {
    await sql.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    throw error;
  }
  return {
    url: url.toString(),
    query: (text: string, values?: unknown[]) => sql.query(text, values),
    close: async () => {
      await sql.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
};

/**
 * Starts the compiled host. It resolves once the host logged `Doric
 * listening`, or once it exited (a refused boot), whichever comes first.
 */
export const startHostProcess = async (
  environment: Readonly<Record<string, string | undefined>>,
  options: { readonly timeoutMs?: number } = {},
): Promise<HostProcess> => {
  const directory = await mkdtemp(join('agents/doric/dist-tests', 'host-'));
  const logFile = join(directory, 'doric.log');
  const port = await freePort();
  const console: string[] = [];
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      // The test's own DORIC_* settings never reach the host by accident.
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('DORIC_'),
        ),
      ),
      DORIC_HOST: '127.0.0.1',
      DORIC_PORT: String(port),
      DORIC_LOG_FILE: logFile,
      DORIC_CREDENTIAL_KEY: credentialKey,
      DORIC_STORAGE_PATH: directory,
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => console.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => console.push(chunk.toString()));
  const exited = new Promise<number | string>((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? signal ?? 'unknown'));
  });
  const lines = async (): Promise<readonly LogLine[]> => {
    const text = await readFile(logFile, 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as LogLine);
  };
  const url = `http://127.0.0.1:${String(port)}`;
  let done = false;
  void exited.then(() => {
    done = true;
  });
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  for (;;) {
    if (done) break;
    if ((await lines()).some(({ msg }) => msg === 'Doric listening')) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      await exited;
      assert.fail(
        `The host never listened:\n${console.join('')}\n${JSON.stringify(await lines())}`,
      );
    }
    await delay(100);
  }

  return {
    url,
    child,
    exited,
    lines,
    output: async () =>
      `${await readFile(logFile, 'utf8').catch(() => '')}\n${console.join('')}`,
    request: (path, method = 'GET', body) =>
      fetch(`${url}${path}`, {
        method,
        signal: AbortSignal.timeout(30_000),
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      }),
    stop: async () => {
      if (!done) child.kill('SIGTERM');
      return exited;
    },
    close: async () => {
      if (!done) child.kill('SIGKILL');
      await exited;
      await rm(directory, { recursive: true, force: true });
    },
  };
};
