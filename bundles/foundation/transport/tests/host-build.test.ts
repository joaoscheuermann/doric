import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildBundle } from 'bundle';

// `transport`'s host part as a process (phase 3, S60d, contract s60 §2.10,
// §6 B1–B3): `buildBundle` bundles `src/host/main.ts` into one
// `dist/host/main.mjs`, which imports `runBundle` from `bundle/host` and lists
// the eight `doric.api.*` services then `hooks/v1`'s `HookHandlerService` as
// the static `[Service, implementation]` literals the build reads, and passes
// `invalidInput`. The kernel entry (`dist/host/index.js`, `dist/kernel.js`)
// and the manifest stay as they were until S62. The process carries no
// Express, Socket.IO or pino.
//
// `buildBundle` rewrites `dist/`, which other test files read while they
// run, so this file builds a copy of the bundle inside the package, where
// it still resolves the workspace's dependencies.

const bundleRoot = fileURLToPath(new URL('../..', import.meta.url));
const workspaceRoot = join(bundleRoot, '..', '..', '..');

/** The exit code of the host SDK when the spawn variables are missing. */
const EXIT_CONFIG = 70;

/** The services `main.ts` lists, in order, by their full service names. */
const TRANSPORT_SERVICES = [
  'doric.api.config.v1.ConfigService',
  'doric.api.credentials.v1.CredentialsService',
  'doric.api.providers.v1.ProvidersService',
  'doric.api.host.v1.HostService',
  'doric.api.projects.v1.ProjectsService',
  'doric.api.threads.v1.ThreadsService',
  'doric.api.terminals.v1.TerminalsService',
  'doric.api.status.v1.StatusService',
  'doric.hooks.v1.HookHandlerService',
];

/** One entry of `readStaticServices` (`bundle`'s build CLI). */
interface StaticServiceEntry {
  readonly protoFile: string;
  readonly service: string;
}

/**
 * The build's own reader of the static `services` list, loaded from the
 * built `bundle` package (`dist/build/cli.js`), which does not export it.
 */
const readStaticServices = async (
  bundleDir: string,
): Promise<readonly StaticServiceEntry[]> => {
  const cli = (await import(
    pathToFileURL(
      join(workspaceRoot, 'packages', 'bundle', 'dist', 'build', 'cli.js'),
    ).href
  )) as {
    readonly readStaticServices: (
      dir: string,
    ) => Promise<readonly StaticServiceEntry[]>;
  };

  return await cli.readStaticServices(bundleDir);
};

/** `doric/api/config/v1/config.proto` + `ConfigService` → `doric.api.config.v1.ConfigService`. */
const fullName = ({ protoFile, service }: StaticServiceEntry): string =>
  `${protoFile.replace(/\/[^/]+\.proto$/, '').replaceAll('/', '.')}.${service}`;

/**
 * Copies what `buildBundle` reads (manifest, package, sources, tsc output).
 *
 * The generated code imports its own files by the package name
 * (`transport/contracts/gen/…`), and `dist/package.json` keeps a file under
 * `dist` from resolving that name to the copy itself, so the copy gets a
 * `node_modules/transport` link to itself: each of its proto files then loads
 * once, from the copy, rather than once from the copy and once from the
 * workspace package.
 */
const copyBundle = async (): Promise<string> => {
  const copy = await mkdtemp(join(bundleRoot, 'dist-tests', 'host-build-'));

  for (const entry of ['manifest.json', 'package.json', 'src', 'dist']) {
    await cp(join(bundleRoot, entry), join(copy, entry), { recursive: true });
  }

  await mkdir(join(copy, 'node_modules'));
  await symlink(copy, join(copy, 'node_modules', 'transport'), 'dir');

  return copy;
};

/** Runs `main.mjs` with no spawn variable and answers its exit and stderr. */
const runWithoutSpawnEnvironment = (
  main: string,
): Promise<{ readonly code: number | null; readonly stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [main],
      {
        env: { PATH: process.env.PATH ?? '' },
        timeout: 10_000,
      },
      (error, _stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof error.code === 'number'
              ? error.code
              : null;

        resolve({ code, stderr: String(stderr) });
      },
    );
  });

/** The module specifiers `source` imports or re-exports, with whether each is type-only. */
const importsOf = (
  source: string,
): readonly { readonly specifier: string; readonly typeOnly: boolean }[] =>
  [
    ...source.matchAll(
      /^(import|export)\s+(type\s+)?[^;]*?\s+from\s+'([^']+)';/gms,
    ),
    ...source.matchAll(/^import\s+'([^']+)';/gm),
  ].map((match) =>
    match.length === 4
      ? { specifier: match[3] ?? '', typeOnly: match[2] !== undefined }
      : { specifier: match[1] ?? '', typeOnly: false },
  );

/** Every `.ts` file under `dir`, recursively. */
const sourcesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
};

/** B3: the packages `src/host/process/**` and `src/host/api/**` may import. */
const allowedPackage = (specifier: string): boolean =>
  /^bundle(\/|$)/.test(specifier) ||
  /^(runtime|files|git|resources|terminal|usage|host-config)\/contracts(\/|$)/.test(
    specifier,
  ) ||
  /^@bufbuild\/protobuf(\/|$)/.test(specifier) ||
  specifier === '@connectrpc/connect' ||
  specifier === 'zod';

void test('B1: the build bundles transport’s host part into a runnable main.mjs and keeps the kernel entries and the manifest', async (t) => {
  const copy = await copyBundle();

  t.after(() => rm(copy, { recursive: true, force: true }));

  await buildBundle(copy);

  const main = join(copy, 'dist', 'host', 'main.mjs');

  assert.ok((await stat(main)).size > 0, 'dist/host/main.mjs is empty');
  for (const kept of [
    join('dist', 'host', 'index.js'),
    join('dist', 'kernel.js'),
  ]) {
    assert.ok(
      (await stat(join(copy, kept))).size > 0,
      `the kernel entry ${kept} is gone`,
    );
  }
  assert.ok(
    (await readFile(join(copy, 'dist', 'manifest.json'))).equals(
      await readFile(join(copy, 'manifest.json')),
    ),
    'dist/manifest.json differs from manifest.json',
  );

  const { code, stderr } = await runWithoutSpawnEnvironment(main);

  assert.equal(code, EXIT_CONFIG, stderr);
  assert.doesNotMatch(stderr, /Cannot find module/);
  assert.doesNotMatch(stderr, /Dynamic require/);

  // B3: the process bundle carries no Express, Socket.IO or pino.
  const bundled = await readFile(main, 'utf8');

  for (const name of ['express', 'socket.io', 'pino']) {
    const quoted = `["']${name.replace('.', '\\.')}["']`;

    assert.doesNotMatch(
      bundled,
      new RegExp(
        `(from\\s*${quoted}|require\\(\\s*${quoted}|import\\(\\s*${quoted})`,
      ),
      `main.mjs imports ${name}`,
    );
  }
});

void test('B2: main.ts lists the eight doric.api services then HookHandlerService statically, in order, and passes invalidInput', async () => {
  const services = await readStaticServices(bundleRoot);

  assert.deepEqual(services.map(fullName), TRANSPORT_SERVICES);

  const main = await readFile(
    join(bundleRoot, 'src', 'host', 'main.ts'),
    'utf8',
  );

  assert.match(main, /runBundle\(\{/);
  assert.match(main, /invalidInput:\s*host\.invalidInput/);
  assert.match(main, /activate:\s*host\.activate/);
  assert.match(main, /deactivate:\s*host\.deactivate/);
});

/** The public API contracts `transport`'s host part serves (A60), in `main.ts` order. */
const API_CONTRACTS = [
  'api.config/v1',
  'api.credentials/v1',
  'api.providers/v1',
  'api.host/v1',
  'api.projects/v1',
  'api.threads/v1',
  'api.terminals/v1',
  'api.status/v1',
];

void test('S62c: contracts.json lists the eight api.*/v1@1.0.0 on host, kind service, cardinality one, local false, and dist/schemas/ holds no file for them', async () => {
  const dist = join(bundleRoot, 'dist');
  const descriptor = JSON.parse(
    await readFile(join(dist, 'contracts.json'), 'utf8'),
  ) as { readonly contracts: readonly { readonly id: string }[] };

  assert.deepEqual(
    descriptor.contracts.filter(({ id }) => id.startsWith('api.')),
    API_CONTRACTS.map((id) => ({
      id,
      version: '1.0.0',
      kind: 'service',
      environment: 'host',
      cardinality: 'one',
      local: false,
      schema: `schemas/${id}.json`,
    })),
  );
  for (const id of API_CONTRACTS) {
    await assert.rejects(
      stat(join(dist, 'schemas', `${id}.json`)),
      { code: 'ENOENT' },
      `dist/schemas/${id}.json`,
    );
  }
});

void test('B3: src/host/process and src/host/api import only bundle, the consumed contracts, protobuf, Connect, zod and their own modules', async () => {
  const files = [
    ...(await sourcesUnder(join(bundleRoot, 'src', 'host', 'process'))),
    ...(await sourcesUnder(join(bundleRoot, 'src', 'host', 'api'))),
  ];

  assert.ok(files.length > 0);
  for (const file of files) {
    const relative = file.slice(bundleRoot.length);

    for (const { specifier, typeOnly } of importsOf(
      await readFile(file, 'utf8'),
    )) {
      if (specifier.startsWith('.')) continue;
      if (
        specifier === 'express' &&
        typeOnly &&
        relative.endsWith(join('api', 'answer.ts'))
      ) {
        continue;
      }

      assert.ok(allowedPackage(specifier), `${relative} imports ${specifier}`);
    }
  }
});
