import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { distributionCatalogSchema, ModelsV1, ToolsV1 } from 'bundle/contracts';
import { PLATFORM_VERSION } from 'bundle/runtime';
import express from 'express';
import pino from 'pino';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';

import { installBridge } from '../src/lib/bridge/socket.js';
import { type Bundles, startBundles } from '../src/lib/bundles/boot.js';

// Build doric first. The host end of the desktop bridge (HR-1), driven as the
// desktop drives it: envelope messages emitted under their `kind` on
// `/doric/bridge`, over the staged bundles and the composition the host
// ships. Activation opens no database, so no case needs one.

const compositionPath = 'app/backend/doric-host/composition.json';

interface Host extends Bundles {
  readonly root: string;
  readonly desktop: Socket;
  close(): Promise<void>;
}

const boot = async (hostBoot: string): Promise<Host> => {
  // A copy, so a published generation re-reads a root this test owns.
  const root = await mkdtemp(
    join('app/backend/doric-host/dist-tests', 'bridge-'),
  );
  await cp('app/backend/doric-host/dist/bundles', root, { recursive: true });
  const app = express();
  const server = createServer(app);
  const io = new SocketServer(server);
  const logger = pino({ enabled: false });
  const bundles = await startBundles({
    bundlesPath: root,
    compositionPath,
    compositionOverridesPath: join(root, 'composition.overrides.json'),
    network: { http: app, server, sockets: io },
    logger,
    hostBoot,
  });
  installBridge({ io, platform: bundles.platform, log: logger });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const desktop = connect(
    `http://127.0.0.1:${String(address.port)}/doric/bridge`,
    { transports: ['websocket'], reconnection: false },
  );
  await new Promise<void>((resolve, reject) => {
    desktop.once('connect', resolve);
    desktop.once('connect_error', reject);
  });

  return {
    ...bundles,
    root,
    desktop,
    close: async () => {
      desktop.disconnect();
      await io.close();
      await bundles.platform.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
};

const withHost = async (run: (host: Host) => Promise<void>) => {
  const host = await boot(randomUUID());

  try {
    await run(host);
  } finally {
    await host.close();
  }
};

let counter = 0;

/** The platform hop the desktop sends (caller `doric`, D-14). */
const wire = () => ({
  caller: { bundleId: 'doric', version: PLATFORM_VERSION, generation: 0 },
  trace: {
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  },
  deadline: 0,
  generation: 0,
});

type Result =
  | { kind: 'result'; id: string; ok: true; output: unknown }
  | {
      kind: 'result';
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

const call = (
  desktop: Socket,
  contract: string,
  method: string,
  input: unknown,
): Promise<Result> => {
  counter += 1;
  const id = `d:c${String(counter)}`;

  return new Promise((resolve) => {
    const listener = (message: Result) => {
      if (message.id === id) {
        desktop.off('result', listener);
        resolve(message);
      }
    };
    desktop.on('result', listener);
    desktop.emit('call', {
      kind: 'call',
      id,
      contract,
      method,
      input,
      ...wire(),
    });
  });
};

const output = async (
  desktop: Socket,
  contract: string,
  method: string,
  input: unknown,
) => {
  const result = await call(desktop, contract, method, input);
  assert.ok(result.ok, JSON.stringify(result));
  return result.output;
};

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const filesUnder = async (root: string, dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(root, dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await filesUnder(root, relative(root, path))));
    } else {
      out.push(relative(root, path).split(sep).join('/'));
    }
  }
  return out;
};

void test('distribution lists every desktop file of the core with the hash of its bytes, and not the host entry', {
  timeout: 60_000,
}, async () => {
  const hostBoot = randomUUID();
  const host = await boot(hostBoot);

  try {
    const catalog = distributionCatalogSchema.parse(
      await output(host.desktop, 'doric.catalog/v1', 'distribution', []),
    );
    const core = catalog.bundles.find(({ id }) => id === 'core');
    assert.ok(core);
    const coreDir = join(host.root, 'core');

    assert.equal(catalog.hostBoot, hostBoot);
    assert.equal(catalog.generation, 1);
    assert.equal(catalog.platformVersion, PLATFORM_VERSION);
    assert.equal(catalog.composition.core, 'core');
    assert.equal(core.state, 'active');
    assert.equal(core.parts.desktopMain, 'desktop/index.js');
    // HR-7: the staged core carries its built desktop part.
    const desktopFiles = await filesUnder(coreDir, 'desktop');
    assert.ok(desktopFiles.includes('desktop/index.js'));
    const files = core.files;
    for (const path of [...desktopFiles, 'manifest.json']) {
      const listed = files.find((file) => file.path === path);
      const bytes = await readFile(join(coreDir, path));
      assert.ok(listed, `${path} is distributed`);
      assert.equal(listed.sha256, sha256(bytes));
      assert.equal(listed.size, bytes.byteLength);
    }
    // The host entry is not distributed (only modules the contracts import are).
    assert.ok(files.every(({ path }) => path !== 'host/index.js'));
    // The host snapshot is the one `doric.catalog/v1.get()` publishes.
    assert.deepEqual(
      catalog.host,
      await output(host.desktop, 'doric.catalog/v1', 'get', []),
    );
  } finally {
    await host.close();
  }
});

void test('artifact answers the bytes of a distributed hash, and not_found for any other hash', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const catalog = distributionCatalogSchema.parse(
      await output(host.desktop, 'doric.catalog/v1', 'distribution', []),
    );
    const core = catalog.bundles.find(({ id }) => id === 'core');
    const file = core?.files.find(({ path }) => path === 'desktop/index.js');
    assert.ok(file);

    const artifact = (await output(
      host.desktop,
      'doric.catalog/v1',
      'artifact',
      { sha256: file.sha256 },
    )) as { sha256: string; base64: string };
    assert.equal(artifact.sha256, file.sha256);
    assert.deepEqual(
      Buffer.from(artifact.base64, 'base64'),
      await readFile(join(host.root, 'core', 'desktop', 'index.js')),
    );

    // A file the host has but does not distribute is not served by its hash.
    const hostOnly = sha256(
      await readFile(join(host.root, 'core', 'host', 'index.js')),
    );
    for (const unknown of [hostOnly, '0'.repeat(64)]) {
      const refused = await call(host.desktop, 'doric.catalog/v1', 'artifact', {
        sha256: unknown,
      });
      assert.equal(refused.ok, false);
      assert.equal(!refused.ok && refused.error.code, 'not_found');
    }

    const malformed = await call(host.desktop, 'doric.catalog/v1', 'artifact', {
      sha256: 'not-a-hash',
    });
    assert.equal(!malformed.ok && malformed.error.code, 'invalid_input');
  });
});

void test('the bundles distribute the documents of their host contracts', {
  timeout: 60_000,
}, async () => {
  // A desktop part routes a host contract by the document its bundle ships;
  // `host-config` is an installed bundle that runs resident in the kernel, and
  // `resources/v1` is the installed `resources` bundle's since the stage-10 host
  // switch.
  await withHost(async (host) => {
    const catalog = distributionCatalogSchema.parse(
      await output(host.desktop, 'doric.catalog/v1', 'distribution', []),
    );
    for (const [bundleId, contract, method] of [
      ['host-config', 'host-config/v1', 'current'],
      ['resources', 'resources/v1', 'project'],
    ] as const) {
      const bundle = catalog.bundles.find(({ id }) => id === bundleId);
      const file = bundle?.files.find(
        ({ path }) => path === `schemas/${contract}.json`,
      );
      assert.ok(file, `${bundleId} lists schemas/${contract}.json`);
      // Its contracts module is distributed like any installed bundle's.
      if (bundleId === 'host-config')
        assert.deepEqual(bundle?.parts, { contracts: 'contracts/index.js' });

      const artifact = (await output(
        host.desktop,
        'doric.catalog/v1',
        'artifact',
        { sha256: file.sha256 },
      )) as { sha256: string; base64: string };
      const bytes = Buffer.from(artifact.base64, 'base64');
      assert.equal(sha256(bytes), file.sha256);
      assert.equal(bytes.byteLength, file.size);
      const document = JSON.parse(bytes.toString('utf8')) as {
        $defs?: Record<string, unknown>;
      };
      assert.ok(
        document.$defs?.[`${method}.input`] !== undefined &&
          document.$defs?.[`${method}.output`] !== undefined,
        `${contract} documents ${method}`,
      );
    }
  });
});

void test('watch emits the new generation once it is published, and stops after unsubscribe', {
  timeout: 120_000,
}, async () => {
  await withHost(async (host) => {
    const events: unknown[] = [];
    const ends: unknown[] = [];
    host.desktop.on('event', (message: { id: string; values: unknown[] }) => {
      if (message.id === 'd:s1') events.push(...message.values);
    });
    host.desktop.on('end', (message: unknown) => ends.push(message));
    host.desktop.emit('subscribe', {
      kind: 'subscribe',
      id: 'd:s1',
      contract: 'doric.catalog/v1',
      method: 'watch',
      input: [],
      ...wire(),
    });
    // The subscription is open once a later call on the same socket answers.
    await output(host.desktop, 'doric.catalog/v1', 'get', []);

    const published = await host.platform.generations.publish();
    assert.deepEqual(published, { status: 'published', generation: 2 });
    const deadline = Date.now() + 10_000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(events, [{ generation: 2 }]);
    const catalog = distributionCatalogSchema.parse(
      await output(host.desktop, 'doric.catalog/v1', 'distribution', []),
    );
    assert.equal(catalog.generation, 2);

    host.desktop.emit('unsubscribe', { kind: 'unsubscribe', id: 'd:s1' });
    await output(host.desktop, 'doric.catalog/v1', 'get', []);
    assert.deepEqual(await host.platform.generations.publish(), {
      status: 'published',
      generation: 3,
    });
    await output(host.desktop, 'doric.catalog/v1', 'get', []);
    assert.deepEqual(events, [{ generation: 2 }]);
    assert.deepEqual(ends, []);
  });
});

void test('disable leaves a bundle out of the next generation and resetComposition brings it back', {
  timeout: 120_000,
}, async () => {
  await withHost(async (host) => {
    const overrides = join(host.root, 'composition.overrides.json');
    const stateOf = async (id: string) => {
      const catalog = distributionCatalogSchema.parse(
        await output(host.desktop, 'doric.catalog/v1', 'distribution', []),
      );
      return {
        generation: catalog.generation,
        state: catalog.bundles.find((bundle) => bundle.id === id)?.state,
      };
    };

    assert.deepEqual(await stateOf('git'), { generation: 1, state: 'active' });

    await output(host.desktop, 'doric.catalog/v1', 'disable', {
      bundleId: 'git',
    });
    assert.deepEqual(await stateOf('git'), {
      generation: 2,
      state: 'disabled',
    });
    assert.deepEqual(JSON.parse(await readFile(overrides, 'utf8')), {
      disabled: ['git'],
    });

    await output(host.desktop, 'doric.catalog/v1', 'resetComposition', []);
    assert.deepEqual(await stateOf('git'), { generation: 3, state: 'active' });
    await assert.rejects(access(overrides), { code: 'ENOENT' });
  });
});

void test('disable refuses the core and a bundle outside the composition, and changes nothing', {
  timeout: 120_000,
}, async () => {
  await withHost(async (host) => {
    const core = await call(host.desktop, 'doric.catalog/v1', 'disable', {
      bundleId: 'core',
    });
    const unknown = await call(host.desktop, 'doric.catalog/v1', 'disable', {
      bundleId: 'nowhere',
    });

    assert.equal(core.ok ? undefined : core.error.code, 'invalid_input');
    assert.equal(unknown.ok ? undefined : unknown.error.code, 'not_found');
    assert.equal(host.platform.generation, 1);
    await assert.rejects(
      access(join(host.root, 'composition.overrides.json')),
      { code: 'ENOENT' },
    );
  });
});

void test('a stream and a plain method are refused through the other request kind', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const asCall = await call(host.desktop, 'doric.catalog/v1', 'watch', []);
    assert.equal(!asCall.ok && asCall.error.code, 'invalid_input');

    const ended = new Promise<{ error?: { code: string } }>((resolve) =>
      host.desktop.once('end', resolve),
    );
    host.desktop.emit('subscribe', {
      kind: 'subscribe',
      id: 'd:s9',
      contract: 'doric.catalog/v1',
      method: 'distribution',
      input: [],
      ...wire(),
    });
    assert.equal((await ended).error?.code, 'invalid_input');

    const missing = await call(host.desktop, 'nothing/v1', 'get', []);
    assert.equal(!missing.ok && missing.error.code, 'unavailable');
  });
});

void test('a desktop quarantine reported over the bridge reaches the host diagnostics', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    await output(host.desktop, 'doric.diagnostics/v1', 'report', {
      bundleId: 'files',
      kind: 'desktop_quarantine',
      message: 'engines_unsatisfied',
    });

    assert.ok(
      host.platform
        .diagnostics()
        .errors.some(
          ({ bundleId, kind, message }) =>
            bundleId === 'files' &&
            kind === 'desktop_quarantine' &&
            message === 'engines_unsatisfied',
        ),
    );
  });
});

/** Opens a bridge stream; resolves its first item or its end. */
const firstOf = (
  desktop: Socket,
  id: string,
  contract: string,
  method: string,
  input: unknown,
) =>
  new Promise<
    | { readonly item: unknown }
    | { readonly end: { readonly code: string; readonly message: string } }
  >((resolve) => {
    const onEvent = (message: { id: string; values: unknown[] }) => {
      if (message.id !== id) return;
      desktop.off('event', onEvent);
      desktop.off('end', onEnd);
      resolve({ item: message.values[0] });
    };
    const onEnd = (message: {
      id: string;
      error?: { code: string; message: string };
    }) => {
      if (message.id !== id) return;
      desktop.off('event', onEvent);
      desktop.off('end', onEnd);
      resolve({ end: message.error ?? { code: '', message: '' } });
    };
    desktop.on('event', onEvent);
    desktop.on('end', onEnd);
    desktop.emit('subscribe', {
      kind: 'subscribe',
      id,
      contract,
      method,
      input,
      ...wire(),
    });
  });

void test('a desktop caller reaches only the host methods its providers expose (HR-10)', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const credential = { kind: 'OPENAI', id: randomUUID() };
    for (const [contract, method, input] of [
      ['secrets/v1', 'resolve', credential],
      ['secrets/v1', 'resolveByKind', ['OPENAI', 'key']],
      ['secrets/v1', 'redactions', []],
      ['runtime/v1', 'recover', []],
      ['runtime/v1', 'dispose', []],
      ['runtime/v1', 'vmSsh', randomUUID()],
      ['runtime.threads/v1', 'spawn', 'prompt'],
      [
        'runtime.threads/v1',
        'storedEventsAfter',
        { id: randomUUID(), afterSequence: 0 },
      ],
      ['runtime.lease/v1', 'exec', { command: 'id' }],
      ['runtime.lease/v1', 'writeFile', ['/etc/passwd', '']],
      ['terminal/v1', 'run', { command: 'id' }],
      ['tools/v1', 'list', []],
    ] as const) {
      const refused = await call(host.desktop, contract, method, input);
      assert.deepEqual(
        refused.ok ? undefined : refused.error.code,
        'unavailable',
        `${contract} ${method}`,
      );
    }
    const watch = await firstOf(
      host.desktop,
      'd:w1',
      'runtime/v1',
      'watch',
      [],
    );
    assert.equal('end' in watch ? watch.end.code : undefined, 'unavailable');
    // The refused dispose did not reach the runtime: it still answers.
    assert.deepEqual(
      await output(host.desktop, 'runtime.terminals/v1', 'list', randomUUID()),
      [],
    );
  });
});

void test('the settings provider reads reach models/v1 over the bridge, the kind lookup included', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const models = host.platform.services.use(ModelsV1);
    const kinds = (await output(
      host.desktop,
      'models/v1',
      'kinds',
      [],
    )) as readonly { id: string }[];
    assert.ok(kinds.length > 0);
    assert.deepEqual(kinds, await models.kinds());
    // The settings client checks a draft against its kind's fields before
    // reading the catalog; every advertised kind answers its descriptor.
    for (const { id } of kinds) {
      assert.deepEqual(
        await output(host.desktop, 'models/v1', 'kind', [id]),
        await models.kind(id),
        id,
      );
    }
    assert.equal(
      await output(host.desktop, 'models/v1', 'kind', ['no-such-kind']),
      undefined,
    );
  });
});

void test('the tool catalog and the host machine are read over the bridge', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const catalog = (await output(
      host.desktop,
      'tools/v1',
      'catalog',
      [],
    )) as readonly { name: string }[];
    const listed = await host.platform.services.use(ToolsV1).list();
    assert.ok(catalog.length > 0);
    assert.deepEqual(
      catalog.map(({ name }) => name),
      listed.map(({ tool }) => tool.name),
    );
    const machine = (await output(
      host.desktop,
      'resources/v1',
      'host',
      [],
    )) as {
      cpuCount: number;
      memoryTotalBytes: number;
    };
    assert.equal(typeof machine.cpuCount, 'number');
    assert.ok(machine.memoryTotalBytes > 0);
  });
});

void test('the runtime watches stream over the bridge and through the generation process', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const projectId = randomUUID();
    assert.deepEqual(
      await firstOf(
        host.desktop,
        'd:w2',
        'runtime.terminals/v1',
        'watchProject',
        [projectId],
      ),
      { item: { kind: 'snapshot', projectId, terminals: [] } },
    );
    const refused = await firstOf(
      host.desktop,
      'd:w3',
      'runtime.threads/v1',
      'watchThread',
      [{ threadId: 'not-an-id', afterSequence: 0 }],
    );
    assert.equal(
      'end' in refused ? refused.end.code : undefined,
      'invalid_input',
    );
  });
});
