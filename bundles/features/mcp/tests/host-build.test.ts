// B1–B4 (phase 3, S59c): `buildBundle` bundles `mcp`'s host part,
// `src/host/main.ts`, into one `dist/host/main.mjs`, which imports
// `runBundle` from `bundle/host` and lists `McpService`,
// `SkillSourcesService`, `ToolHandlerService` and `HookHandlerService` as the
// static `[Service, implementation]` literals the build reads (S29). The
// kernel entry, the client and the manifest stay as they were until S62. The
// host part reads no asset, and imports only what the boundary rules allow.
//
// `buildBundle` rewrites `dist/`, which other test files read while they
// run, so this file builds a copy of the bundle inside the package, where
// it still resolves the workspace's dependencies.

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

const bundleRoot = fileURLToPath(new URL('../..', import.meta.url));
const workspaceRoot = join(bundleRoot, '..', '..', '..');
const hostDir = join(bundleRoot, 'src', 'host');

/** The exit code of the host SDK when the spawn variables are missing. */
const EXIT_CONFIG = 70;

/** The services `main.ts` lists, in order, by their full service names. */
const MCP_SERVICES = [
  'doric.mcp.v1.McpService',
  'doric.default.skill_sources.v1.SkillSourcesService',
  'doric.tools.v1.ToolHandlerService',
  'doric.hooks.v1.HookHandlerService',
];

/** What `src/host` may import besides its own modules and `node:` (B4). */
const ALLOWED_IMPORTS: readonly RegExp[] = [
  /^bundle\//u,
  /^runtime\/contracts(\/gen\/.*)?$/u,
  /^default\/contracts(\/gen\/.*)?$/u,
  /^storage\/rpc$/u,
  /^sandbox$/u,
  /^tool$/u,
  /^oauth$/u,
  /^@modelcontextprotocol\/sdk\//u,
  /^@bufbuild\/protobuf(\/.*)?$/u,
  /^@connectrpc\/connect$/u,
  /^zod$/u,
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

/** `doric/mcp/v1/mcp.proto` + `McpService` → `doric.mcp.v1.McpService`. */
const fullName = ({ protoFile, service }: StaticServiceEntry): string =>
  `${protoFile.replace(/\/[^/]+\.proto$/, '').replaceAll('/', '.')}.${service}`;

/**
 * Copies what `buildBundle` reads (manifest, package, sources, tsc output).
 *
 * The generated code imports its own files by the package name
 * (`mcp/contracts/gen/…`), and `dist/package.json` keeps a file under `dist`
 * from resolving that name to the copy itself, so the copy gets a
 * `node_modules/mcp` link to itself: each of its proto files then loads once,
 * from the copy.
 */
const copyBundle = async (): Promise<string> => {
  const copy = await mkdtemp(join(bundleRoot, 'dist-tests', 'host-build-'));

  for (const entry of ['manifest.json', 'package.json', 'src', 'dist']) {
    await cp(join(bundleRoot, entry), join(copy, entry), { recursive: true });
  }

  await mkdir(join(copy, 'node_modules'));
  await symlink(copy, join(copy, 'node_modules', 'mcp'), 'dir');

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

const nonEmpty = async (path: string): Promise<boolean> =>
  (await stat(path)).size > 0;

/** The non-test TypeScript files of `src/host`, with their text. */
const hostSources = async (): Promise<
  readonly { readonly file: string; readonly text: string }[]
> => {
  const files = (await readdir(hostDir)).filter((file) => file.endsWith('.ts'));

  return Promise.all(
    files.map(async (file) => ({
      file,
      text: await readFile(join(hostDir, file), 'utf8'),
    })),
  );
};

void test('B1: the build bundles mcp’s host part into a main.mjs that exits 70 without the spawn variables, and keeps the kernel entry, the client and the manifest', async (t) => {
  const copy = await copyBundle();

  t.after(() => rm(copy, { recursive: true, force: true }));

  await buildBundle(copy);

  const dist = join(copy, 'dist');
  const main = join(dist, 'host', 'main.mjs');

  assert.ok(await nonEmpty(main), 'dist/host/main.mjs is empty');
  for (const kept of [
    ['host', 'index.js'],
    ['client', 'index.js'],
  ]) {
    assert.ok(await nonEmpty(join(dist, ...kept)), `dist/${kept.join('/')}`);
  }
  assert.ok(
    (await readFile(join(dist, 'manifest.json'))).equals(
      await readFile(join(copy, 'manifest.json')),
    ),
    'dist/manifest.json differs from manifest.json',
  );

  const { code, stderr } = await runWithoutSpawnEnvironment(main);

  assert.equal(code, EXIT_CONFIG, stderr);
  assert.doesNotMatch(stderr, /Cannot find module/);
  assert.doesNotMatch(stderr, /Dynamic require/);
});

void test('B2: main.ts lists McpService, SkillSourcesService, ToolHandlerService and HookHandlerService statically, in that order', async () => {
  const services = await readStaticServices(bundleRoot);

  assert.deepEqual(services.map(fullName), MCP_SERVICES);
});

void test('B3: src/host reads no asset: no readFile, import.meta.url, createRequire or dynamic import', async () => {
  const offending = (await hostSources()).flatMap(({ file, text }) =>
    [/readFile/u, /import\.meta\.url/u, /createRequire/u, /\bimport\(/u]
      .filter((pattern) => pattern.test(text))
      .map((pattern) => `${file}: ${String(pattern)}`),
  );

  assert.deepEqual(offending, []);
});

void test('B4: src/host imports only bundle/*, runtime and default contracts, storage/rpc, sandbox, tool, oauth, the MCP SDK, protobuf, Connect, zod, node: and its own modules', async () => {
  const offending = (await hostSources()).flatMap(({ file, text }) =>
    [...text.matchAll(/\bfrom\s+'([^']+)'/gu)]
      .map((match) => match[1] ?? '')
      .filter(
        (specifier) =>
          !specifier.startsWith('./') &&
          !specifier.startsWith('../contracts/') &&
          !specifier.startsWith('node:') &&
          !ALLOWED_IMPORTS.some((pattern) => pattern.test(specifier)),
      )
      .map((specifier) => `${file}: ${specifier}`),
  );

  assert.deepEqual(offending, []);
});
