// Dev-only: `npm run doric:fake-host` — a fake Doric host that runs inside this
// repository, in memory, so the desktop can boot without Postgres, a Docker
// sandbox or a real agent runtime.
//
// What it serves:
//
//  - `doric.catalog/v1` from the same staged bundles the host build produces
//    (`app/backend/doric-host/dist/bundles` by default): the desktop downloads
//    the repository's own desktopMain and client parts from here.
//  - `runtime/v1` and `runtime.threads/v1` from a small fixed workspace, so the
//    sidebar, the project tabs and the Screens group of the sidebar have data.
//  - `GET /status`, `GET /projects`, `GET /threads` over HTTP.
//  - `GET /reload` rebuilds the catalog from the staged files and tells every
//    `doric.catalog/v1.watch` subscriber that a new generation exists.
//
// Point the desktop at it with `DORIC_HOST_URL=<the URL printed below>`.
// Nothing here is loaded by the host, the packaged app or any test.

import { join, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { createDevCatalog, resolveBundlesRoot } from './bundles.mjs';
import { createContracts } from './contracts.mjs';
import { createLog } from './log.mjs';
import { startFakeHost } from './server.mjs';
import { createWorkspace } from './workspace.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..', '..');

const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);

  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
};

const port = Number(
  flag('port', env.DORIC_FAKE_PORT ?? env.DORIC_PORT ?? '3000'),
);
const host = flag('host', env.DORIC_FAKE_HOST ?? '127.0.0.1');
const quiet = argv.includes('--quiet') || env.DORIC_FAKE_QUIET === '1';
const bundlesOverride = flag('bundles', env.DORIC_FAKE_BUNDLES ?? undefined);
const compositionPath = resolve(
  flag(
    'composition',
    env.DORIC_FAKE_COMPOSITION ??
      join(root, 'app/backend/doric-host/composition.json'),
  ),
);

const log = createLog({ quiet });

const hostBoot = `dev-${Date.now().toString(36)}`;
const watchers = new Set();
let current;

const bundlesRoot = await resolveBundlesRoot({
  root,
  override: bundlesOverride,
  log,
}).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n` +
      'Build the bundles with `npx nx run doric-host:build-bundles`, or point ' +
      'DORIC_FAKE_BUNDLES at a staged directory.\n',
  );

  return exit(1);
});

const build = async (generation) => {
  current = await createDevCatalog({
    bundlesRoot,
    compositionPath,
    generation,
    hostBoot,
  });

  return current;
};

const catalog = {
  current: () => current,
  watch: (sink) => {
    watchers.add(sink);

    return () => watchers.delete(sink);
  },
  reload: async () => {
    const next = await build(current.catalog.generation + 1);

    for (const sink of watchers) {
      sink.push({ generation: next.catalog.generation });
    }

    return next.catalog.generation;
  },
};

await build(1);

const workspace = createWorkspace();
const contracts = createContracts({ workspace, catalog, log });

// A port already held is the common failure — a real host, or a fake host from
// an earlier shell. Say so, with the way out, instead of a bare stack trace.
const server = await startFakeHost({
  port,
  host,
  workspace,
  catalog,
  contracts,
  log,
  version: 'dev',
  reload: catalog.reload,
}).catch((error) => {
  if (error?.code === 'EADDRINUSE') {
    process.stderr.write(
      `[fake-host] ${host}:${port} is already in use: another host (or a fake ` +
        'host from an earlier shell) holds it.\n' +
        '[fake-host] Free the port, or start this one elsewhere: ' +
        'DORIC_FAKE_PORT=3010 npm run doric:fake-host\n',
    );

    return exit(1);
  }

  throw error;
});

log.note(
  `bundles: ${bundlesRoot} (${catalog.current().bundleIds.length} bundles, generation ${catalog.current().catalog.generation})`,
);
log.note(`composition: ${compositionPath}`);
log.note(`fake host listening on ${server.url}`);
log.note(`bridge namespace ${server.url}/doric/bridge`);
log.note(
  'point the desktop at it: DORIC_HOST_URL=' +
    server.url +
    ' DISPLAY=:100 npm run doric:dev',
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.note(`stopping on ${signal}`);
    void server.close().then(() => exit(0));
  });
}
