#!/usr/bin/env node
/**
 * Phase 0 spike (docs/designs/grpc-processes.md, AC0.3 and T0.1; deleted in
 * phase 7). Builds one single executable application (SEA) per bundle with
 * esbuild and `node --build-sea` (`sqlite-node`, a stand-in, `papercraft`,
 * `runtime`, `mcp` and `docker`) and the native stub of `sqlite`
 * (`scripts/sea-spike/stub-rs`), starts each against a stub router, and
 * records its time from spawn to Hello, its size and its RSS after activation
 * and one idle minute. Then it measures today's host and generation process,
 * idle with the shipped composition, and applies RK1's rule.
 *
 * Usage: node scripts/sea-spike.mjs [--idle-seconds N] [--skip-today]
 * The router and the client import the control protocol from
 * `bundle/contracts/gen`: run `npx nx run bundle:build` first (which runs
 * `bundle:generate-proto`).
 * Today's host needs `npx nx build doric-host`, `DORIC_DATABASE_URL` and the
 * migrations applied (`npx nx run doric-host:migrate`).
 *
 * Exits 1 when an executable fails to build, does not say Hello within the
 * timeout, or `papercraft` does not complete its esbuild build and Tailwind
 * compile. RK1's rule is reported, not enforced: the owner decides on it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const spike = join(root, 'scripts', 'sea-spike');
const out = join(root, 'dist', 'sea-spike');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const idleSeconds = Number(option('--idle-seconds', '60'));
const skipToday = args.includes('--skip-today');

const HELLO_TIMEOUT_MS = 30_000;
const HOST_LISTEN_TIMEOUT_MS = 180_000;
const GIB = 1024 ** 3;

/** The five SEAs of AC0.3, with the bundle host part each one carries. */
const seas = [
  { id: 'sqlite-node', entry: 'sqlite-node.ts' },
  { id: 'papercraft', entry: 'papercraft.ts', native: true },
  { id: 'runtime', entry: 'runtime.ts' },
  { id: 'mcp', entry: 'mcp.ts' },
  { id: 'docker', entry: 'docker.ts' },
];

/**
 * The packages `papercraft` loads with `require` from its extracted assets
 * instead of bundling them: a platform binary and a native addon, which
 * phase 3 loads through `context.assets.require` (spec, section 14).
 */
const NATIVE_PACKAGES = ['esbuild', 'tailwindcss', '@tailwindcss/oxide'];

const fail = (message) => {
  console.error(`sea-spike: ${message}`);
  process.exit(1);
};

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(' ')} exited with ${result.status}`);
  }
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  fail(
    `node --build-sea needs Node 25.5 or later; this is ${process.version}.`,
  );
}
if (process.platform !== 'linux') fail('RSS is read from /proc: run on Linux.');

// The esbuild guard of the spec's implementation notes ----------------------

/**
 * Collects every dynamic `import()` whose argument is not a string literal:
 * an SEA cannot load it from the filesystem. Phase 3's build fails on one; the
 * spike lists them so the feature doc can say what phase 3 meets.
 */
const urlRead =
  /new URL\(\s*['"`]([^'"`$]+)['"`]\s*,\s*import\.meta\.url\s*\)/g;

/**
 * Also collects every `new URL('<path>', import.meta.url)` of a bundle's own
 * sources into `relativeReads`: bundled, such a read resolves against the
 * executable's directory (spec, section 14, "Assets"). Phase 3 moves each to
 * `context.assets.read`; the spike copies the file beside the executable so the
 * module still loads, and lists it.
 */
const dynamicImportGuard = (found, relativeReads) => ({
  name: 'dynamic-import-guard',
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      if (!path.includes('/node_modules/')) {
        for (const match of source.matchAll(urlRead)) {
          relativeReads.add(`${relative(root, path)}\u0000${match[1]}`);
        }
      }
      if (!/\bimport\s*\(/.test(source)) return undefined;
      const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          !(
            node.arguments[0] &&
            (ts.isStringLiteral(node.arguments[0]) ||
              ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
          )
        ) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart());
          found.add(`${relative(root, path)}:${line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      return undefined;
    });
  },
});

/** An ESM bundle's `require` for the CommonJS dependencies esbuild inlines. */
const requireBanner =
  "import { createRequire as __spikeCreateRequire } from 'node:module';\n" +
  'const require = __spikeCreateRequire(import.meta.url);';

// Build ----------------------------------------------------------------------

/** The files of a package directory, recursively, relative to `root`. */
const filesOf = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesOf(path);
    return entry.isFile() ? [relative(root, path)] : [];
  });

const packageDir = (name) => {
  const directory = join(root, 'node_modules', name);
  if (!existsSync(join(directory, 'package.json'))) {
    fail(`${name} is not installed in node_modules`);
  }
  return directory;
};

/** The SEA assets of `papercraft`'s native packages, for this platform. */
const nativeAssets = () => {
  const arch = process.arch;
  const names = [
    'esbuild',
    `@esbuild/linux-${arch}`,
    'tailwindcss',
    '@tailwindcss/oxide',
    `@tailwindcss/oxide-linux-${arch}-gnu`,
  ];
  return names.flatMap((name) =>
    filesOf(packageDir(name)).filter(
      (file) =>
        !/\.(d\.[cm]?ts|map|md)$/.test(file) && !file.endsWith('/LICENSE'),
    ),
  );
};

const buildSea = async ({ id, entry, native }) => {
  const directory = join(out, id);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  const dynamicImports = new Set();
  const relativeReads = new Set();
  const result = await esbuild.build({
    entryPoints: [join(spike, 'entries', entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node26',
    outfile: join(directory, 'main.mjs'),
    external: ['node:*', ...(native ? NATIVE_PACKAGES : [])],
    conditions: ['@org/source'],
    banner: { js: requireBanner },
    logLevel: 'error',
    metafile: true,
    plugins: [dynamicImportGuard(dynamicImports, relativeReads)],
  });

  const copied = [];
  for (const read of relativeReads) {
    const [source, target] = read.split('\u0000');
    const from = join(root, dirname(source), target);
    if (!existsSync(from) || statSync(from).isDirectory()) continue;
    const to = join(directory, target);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(`${source}: ${target}`);
  }

  const assets = native ? nativeAssets() : [];
  const config = {
    main: join(directory, 'main.mjs'),
    mainFormat: 'module',
    output: join(directory, `doric-${id}`),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    assets: Object.fromEntries([
      ...assets.map((file) => [file, join(root, file)]),
      ...(native
        ? [['spike-assets.json', join(directory, 'spike-assets.json')]]
        : []),
    ]),
  };
  if (native) {
    writeFileSync(join(directory, 'spike-assets.json'), JSON.stringify(assets));
  }
  writeFileSync(
    join(directory, 'sea-config.json'),
    JSON.stringify(config, null, 2),
  );
  run(process.execPath, ['--build-sea', join(directory, 'sea-config.json')]);

  return {
    id,
    kind: 'sea',
    executable: config.output,
    mainBytes: statSync(config.main).size,
    inputs: Object.keys(result.metafile.inputs).length,
    dynamicImports: [...dynamicImports].sort(),
    relativeReads: copied.sort(),
  };
};

const buildStub = () => {
  run('npx', ['buf', 'export', '.', '--output', 'dist/proto']);
  run('cargo', [
    'build',
    '--release',
    '--locked',
    '-p',
    'doric-spike-stub',
    '--target-dir',
    'dist/target/doric-spike-stub',
  ]);
  return {
    id: 'sqlite (native stub)',
    kind: 'native',
    executable: join(
      root,
      'dist',
      'target',
      'doric-spike-stub',
      'release',
      'doric-spike-stub',
    ),
  };
};

// Measure --------------------------------------------------------------------

/** Resident set size of one process, in bytes (`VmRSS` of /proc/<pid>/status). */
const rssOf = (pid) => {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kib = Number(/^VmRSS:\s+(\d+) kB/m.exec(status)?.[1] ?? 0);
    return kib * 1024;
  } catch {
    return 0;
  }
};

/** Every descendant of `pid`, from the `ppid` field of /proc/<pid>/stat. */
const descendantsOf = (pid) => {
  const parents = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      parents.set(Number(entry), ppid);
    } catch {}
  }
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const [child, parent] of parents) {
      if (parent === current) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
};

const mib = (bytes) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

const startInstance = async (router, built) => {
  const token = randomBytes(32).toString('base64url');
  const cache = mkdtempSync(
    join(tmpdir(), `doric-spike-${built.id.split(' ')[0]}-`),
  );
  const lines = [];
  const stderr = [];
  const started = performance.now();
  const child = spawn(built.executable, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DORIC_ROUTER_URL: router.url,
      DORIC_INSTANCE_TOKEN: token,
      DORIC_BUNDLE_ID: built.id.split(' ')[0],
      DORIC_GENERATION: '1',
      DORIC_INCARNATION: '1',
      DORIC_BUNDLE_CACHE: cache,
    },
  });
  child.stdout.setEncoding('utf8').on('data', (chunk) => lines.push(chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));
  const exited = new Promise((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );

  const outcome = await Promise.race([
    router.helloOf(token).then((record) => ({ record })),
    exited.then((code) => ({ error: `exited with ${code} before its Hello` })),
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ error: 'no Hello within the timeout' }),
        HELLO_TIMEOUT_MS,
      ),
    ),
  ]);
  if (outcome.error) {
    child.kill('SIGKILL');
    return { ...built, error: `${outcome.error}: ${stderr.join('').trim()}` };
  }

  // The activation report follows the Accepted (TypeScript SEAs only).
  let activation;
  if (built.kind === 'sea') {
    const deadline = Date.now() + HELLO_TIMEOUT_MS;
    while (activation === undefined && Date.now() < deadline) {
      const line = lines
        .join('')
        .split('\n')
        .find((text) => text.startsWith('{"spike"'));
      if (line) activation = JSON.parse(line).spike.activation;
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (activation === undefined) {
      child.kill('SIGKILL');
      return {
        ...built,
        error: `no activation report: ${stderr.join('').trim()}`,
      };
    }
  }

  return {
    ...built,
    child,
    cache,
    spawnToHelloMs: outcome.record.at - started,
    protocolVersion: outcome.record.hello.protocolVersion,
    activation,
    sizeBytes: statSync(built.executable).size,
  };
};

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** Today's host with the shipped composition, idle: its RSS and its children's. */
const measureToday = async () => {
  const main = join(
    root,
    'app',
    'backend',
    'doric-host',
    'dist',
    'src',
    'index.js',
  );
  if (!existsSync(main))
    return {
      error: `${relative(root, main)} is missing: run npx nx build doric-host`,
    };
  if (!process.env.DORIC_DATABASE_URL)
    return { error: 'DORIC_DATABASE_URL is not set' };

  const state = mkdtempSync(join(tmpdir(), 'doric-spike-today-'));
  const log = join(state, 'doric.log');
  const host = spawn(process.execPath, [main], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DORIC_HOST: '127.0.0.1',
      DORIC_PORT: String(await freePort()),
      DORIC_LOG_FILE: log,
      DORIC_STORAGE_PATH: join(state, 'storage'),
      DORIC_CREDENTIAL_KEY:
        process.env.DORIC_CREDENTIAL_KEY ?? randomBytes(32).toString('base64'),
    },
  });
  const output = [];
  host.stdout.setEncoding('utf8').on('data', (chunk) => output.push(chunk));
  host.stderr.setEncoding('utf8').on('data', (chunk) => output.push(chunk));
  const exited = new Promise((resolve) =>
    host.once('exit', (code) => resolve(code)),
  );
  const started = performance.now();

  const listening = () =>
    (existsSync(log) &&
      readFileSync(log, 'utf8').includes('Doric listening')) ||
    output.join('').includes('Doric listening');
  let code;
  host.once('exit', (value) => {
    code = value;
  });
  while (
    !listening() &&
    code === undefined &&
    performance.now() - started < HOST_LISTEN_TIMEOUT_MS
  ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!listening()) {
    host.kill('SIGKILL');
    return {
      error: `the host did not listen (exit ${code}): ${output.join('').slice(-2000)}`,
    };
  }
  const listenMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000));

  const processes = [host.pid, ...descendantsOf(host.pid)];
  const rss = processes.map((pid) => ({ pid, rss: rssOf(pid) }));
  host.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  host.kill('SIGKILL');
  rmSync(state, { recursive: true, force: true });
  return {
    listenMs,
    processes: rss,
    totalBytes: rss.reduce((sum, { rss: bytes }) => sum + bytes, 0),
  };
};

// Main -----------------------------------------------------------------------

const helpers = join(out, 'router.mjs');
await esbuild.build({
  entryPoints: [join(spike, 'router.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  outfile: helpers,
  logLevel: 'error',
});
const { startRouter } = await import(pathToFileURL(helpers).href);

const built = [];
for (const sea of seas) built.push(await buildSea(sea));
built.push(buildStub());

const router = await startRouter();
const instances = [];
for (const item of built) instances.push(await startInstance(router, item));

const failures = instances.filter((instance) => instance.error);
const papercraft = instances.find((instance) => instance.id === 'papercraft');
if (
  papercraft &&
  !papercraft.error &&
  !(
    papercraft.activation?.esbuildBytes > 0 &&
    papercraft.activation?.tailwindHasFlex === true
  )
) {
  failures.push({
    id: 'papercraft',
    error: `esbuild or Tailwind did not run: ${JSON.stringify(papercraft.activation)}`,
  });
}

const running = instances.filter((instance) => !instance.error);
if (running.length > 0) {
  console.log(
    `sea-spike: ${running.length} instances said Hello; idling ${idleSeconds} s`,
  );
  await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000));
}
for (const instance of running) {
  instance.rssBytes = rssOf(instance.child.pid);
  instance.child.kill('SIGTERM');
  rmSync(instance.cache, { recursive: true, force: true });
}
await router.close();

const today = skipToday
  ? { error: 'skipped (--skip-today)' }
  : await measureToday();

const seaRss = running
  .filter((instance) => instance.kind === 'sea')
  .map((instance) => instance.rssBytes);
const meanSeaRss =
  seaRss.length > 0
    ? seaRss.reduce((sum, bytes) => sum + bytes, 0) / seaRss.length
    : Number.NaN;
const projected = meanSeaRss * 26;
const rk1 = {
  meanSeaRssBytes: meanSeaRss,
  projectedBytes: projected,
  todayBytes: today.totalBytes ?? null,
  // A55: the ceiling is 2.75 GiB idle, with no bound relative to today's.
  withinCeiling: projected <= 2.75 * GIB,
};

const results = {
  node: process.version,
  arch: process.arch,
  idleSeconds,
  instances: instances.map(({ child, cache, ...rest }) => rest),
  today,
  rk1,
};
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, `results-${process.arch}.json`),
  `${JSON.stringify(results, null, 2)}\n`,
);

console.log(
  `\n# SEA spike on Node ${process.version} (${process.arch}), idle ${idleSeconds} s\n`,
);
console.log('| Executable | Spawn to Hello | Size | Idle RSS | Notes |');
console.log('| --- | ---: | ---: | ---: | --- |');
for (const instance of instances) {
  const notes = instance.error
    ? `FAILED: ${instance.error}`
    : [
        instance.activation
          ? `activation ${JSON.stringify(instance.activation)}`
          : '',
        instance.dynamicImports?.length
          ? `${instance.dynamicImports.length} non-literal import()`
          : '',
      ]
        .filter(Boolean)
        .join('; ');
  console.log(
    `| ${instance.id} | ${instance.spawnToHelloMs?.toFixed(0) ?? '-'} ms | ${instance.sizeBytes ? mib(instance.sizeBytes) : '-'} | ${instance.rssBytes ? mib(instance.rssBytes) : '-'} | ${notes} |`,
  );
}
for (const instance of instances) {
  if (instance.relativeReads?.length) {
    console.log(
      `\nFiles ${instance.id} reads relative to import.meta.url (copied beside the executable):\n${instance.relativeReads.map((at) => `- ${at}`).join('\n')}`,
    );
  }
  if (instance.dynamicImports?.length) {
    console.log(
      `\nNon-literal import() reached by ${instance.id}:\n${instance.dynamicImports.map((at) => `- ${at}`).join('\n')}`,
    );
  }
}
console.log(
  today.error
    ? `\nToday's host: not measured: ${today.error}`
    : `\nToday's host + generation process, idle: ${mib(today.totalBytes)} over ${today.processes.length} processes (${today.processes.map(({ rss }) => mib(rss)).join(', ')}); listening after ${today.listenMs.toFixed(0)} ms`,
);
console.log(
  `RK1: mean SEA RSS ${mib(meanSeaRss)} x 26 = ${mib(projected)}; <= 2.75 GiB (A55): ${rk1.withinCeiling}`,
);
console.log(
  `Results: ${relative(root, join(out, `results-${process.arch}.json`))}`,
);

if (failures.length > 0) {
  fail(failures.map(({ id, error }) => `${id}: ${error}`).join('\n'));
}
process.exit(0);
