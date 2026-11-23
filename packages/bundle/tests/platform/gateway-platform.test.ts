// The gateway of a running platform (spec `docs/designs/grpc-processes.md`,
// section 11, "Gateway and public listener", section 6, "Publish"; T2.9,
// T2.16): `startPlatform` with a public address serves the `DESKTOP` methods
// and HTTP prefixes of its resolution on one port, follows each publish
// without a restart, and lets a call or a proxied connection in flight to a
// draining instance finish there. Each bundle is a process of the fixture
// `tests/fixtures/scripted`; the `http-prefix` mode reports an `httpPort`.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import test, { describe, type TestContext } from 'node:test';

import type { DescService } from '@bufbuild/protobuf';
import {
  type Client,
  Code,
  ConnectError,
  createClient,
} from '@connectrpc/connect';
import {
  createConnectTransport,
  createGrpcTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';

import {
  file_doric_models_v1_models,
  ModelsService,
} from '../../src/contracts/gen/doric/models/v1/models_pb.js';
import { file_doric_settings_v1_settings } from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import { file_doric_tools_v1_tools } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { fromConnectError } from '../../src/contracts/status.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import {
  type Platform,
  PublicListenerBindingError,
  startPlatform,
} from '../../src/platform/index.js';
import type { Timings } from '../../src/platform/supervisor/timings.js';
import { DiagnosticsStore } from '../../src/runtime/index.js';
import {
  commandsOf,
  type FixtureBundle,
  fixtureLog,
  isAlive,
  type PlatformHost,
  resolveHost,
  setupPlatform,
  testTimings,
  until,
  within,
} from '../support/scripted-host.js';

// ---------------------------------------------------------------------------
// Helpers

const index = createCatalogIndex([
  file_doric_tools_v1_tools,
  file_doric_settings_v1_settings,
  file_doric_models_v1_models,
]);

const models: FixtureBundle = {
  mode: 'serve-models',
  provides: ['models/v1@1.0.0'],
};

const relay: FixtureBundle = { mode: 'http-prefix', httpPrefix: '/screen/' };

const failureOf = async (promise: Promise<unknown>): Promise<ConnectError> => {
  try {
    await within(promise, 'the call', 4_000);
  } catch (error) {
    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );

    return error;
  }

  return assert.fail('the call succeeded');
};

const assertFailure = (error: ConnectError, grpc: Code, code: string): void => {
  assert.equal(fromConnectError(error).code, code, error.message);
  assert.equal(error.code, grpc, error.message);
};

/** Boots `bundles` with a public listener on `127.0.0.1:0`. */
const boot = (
  t: TestContext,
  bundles: Readonly<Record<string, FixtureBundle>>,
  timings: Partial<Timings> = {},
): Promise<PlatformHost> =>
  setupPlatform(t, bundles, {
    publicAddress: '127.0.0.1:0',
    index,
    timings,
  });

const publicPortOf = (platform: Platform): number => {
  const port = platform.publicPort;

  assert.equal(typeof port, 'number', 'the platform has a public port');

  return port as number;
};

/** A gRPC client of `service` on the public port. */
const grpcOf = <S extends DescService>(
  t: TestContext,
  platform: Platform,
  service: S,
): Client<S> => {
  const baseUrl = `http://127.0.0.1:${publicPortOf(platform)}`;
  const session = new Http2SessionManager(baseUrl);

  t.after(() => session.abort());

  return createClient(
    service,
    createGrpcTransport({ baseUrl, sessionManager: session }),
  );
};

/** A Connect JSON client of `service` over HTTP/1.1 on the public port. */
const jsonOf = <S extends DescService>(
  platform: Platform,
  service: S,
): Client<S> =>
  createClient(
    service,
    createConnectTransport({
      baseUrl: `http://127.0.0.1:${publicPortOf(platform)}`,
      httpVersion: '1.1',
      useBinaryFormat: false,
    }),
  );

const labelOf = async (
  client: Client<typeof ModelsService>,
  id = 'k',
): Promise<string | undefined> =>
  (await within(client.kind({ id }), 'kind', 4_000)).modelKindDescriptor?.label;

/** One HTTP/1.1 request on its own connection. */
const httpGet = (
  port: number,
  path: string,
): Promise<{ readonly status: number; readonly body: string }> =>
  within(
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, agent: false },
        (response) => {
          let body = '';

          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body }),
          );
          response.on('error', reject);
        },
      );

      request.on('error', reject);
      request.end();
    }),
    `GET ${path}`,
    4_000,
  );

/** An upgraded connection through the public port. */
interface Upgraded {
  readonly socket: net.Socket;
  received(): string;
  readonly closed: Promise<void>;
}

const upgrade = async (
  t: TestContext,
  port: number,
  path: string,
  head: string,
): Promise<Upgraded> => {
  const socket = net.connect(port, '127.0.0.1');
  let data = '';

  t.after(() => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', (chunk: Buffer) => {
    data += chunk.toString('latin1');
  });

  const closed = new Promise<void>((resolve) =>
    socket.on('close', () => resolve()),
  );

  await within(once(socket, 'connect'), 'the connection');
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n${head}`,
  );

  return { socket, received: () => data, closed };
};

// ---------------------------------------------------------------------------
// One port (T2.9)

describe('the gateway of a platform', () => {
  test('serves a DESKTOP method on the public port over gRPC and over Connect JSON on HTTP/1.1', async (t) => {
    const env = await boot(t, { models });
    const port = publicPortOf(env.platform);

    assert.notEqual(port, env.platform.routerPort);
    assert.equal(await labelOf(grpcOf(t, env.platform, ModelsService)), 'g1');
    assert.equal(await labelOf(jsonOf(env.platform, ModelsService)), 'g1');
  });

  test('a method not exposed to DESKTOP answers UNIMPLEMENTED unknown_contract, never reaching the bundle', async (t) => {
    const env = await boot(t, { models });

    assertFailure(
      await failureOf(grpcOf(t, env.platform, ModelsService).resolve({})),
      Code.Unimplemented,
      'unknown_contract',
    );
    assert.equal(env.log.countOf('models', 'call'), 0);
  });

  test('a bundle prefix proxies a request and an upgrade, byte for byte, to its own listener', async (t) => {
    const env = await boot(t, { relay });
    const port = publicPortOf(env.platform);

    assert.deepEqual(await httpGet(port, '/screen/a/b?c=1'), {
      status: 200,
      body: 'g1 GET /screen/a/b?c=1',
    });

    const connection = await upgrade(t, port, '/screen/ws', 'hello');

    await until(
      () => connection.received().includes('g1:hello'),
      'the head through the upgrade',
    );
    assert.match(connection.received(), /^HTTP\/1\.1 101/);

    connection.socket.write(Buffer.from([0x00, 0xff, ...Buffer.from('raw')]));
    await until(
      () => connection.received().includes('g1:\u0000\u00ffraw'),
      'raw bytes both ways',
    );
  });

  test('a path under no prefix answers 404, and an upgrade under none gets HTTP/1.1 404', async (t) => {
    const env = await boot(t, { relay });
    const port = publicPortOf(env.platform);

    assert.equal((await httpGet(port, '/other/a')).status, 404);
    assert.equal((await httpGet(port, '/screen')).status, 404);

    const connection = await upgrade(t, port, '/other/ws', '');

    await within(connection.closed, 'the socket to close');

    assert.match(connection.received(), /^HTTP\/1\.1 404/);
    assert.equal(env.log.countOf('relay', 'upgrade'), 0);
  });

  test('an occupied public address rejects with PublicListenerBindingError and leaves nothing running', async (t) => {
    const occupant = net.createServer();

    occupant.listen(0, '127.0.0.1');
    await once(occupant, 'listening');
    t.after(() => occupant.close());

    const { port } = occupant.address() as AddressInfo;
    const log = fixtureLog(t);
    const resolved = resolveHost({ models });
    const diagnostics = new DiagnosticsStore({ generation: 1 });

    diagnostics.load(resolved);

    let started: Platform | undefined;

    await assert
      .rejects(
        (async () => {
          started = await within(
            startPlatform({
              index,
              publicAddress: `127.0.0.1:${port}`,
              resolved,
              commandOf: commandsOf({ models }, log),
              digestOf: () => '',
              env: { PATH: process.env.PATH },
              timings: testTimings,
              diagnostics,
              exit: () => {},
              writeLog: () => {},
            }),
            'the boot',
          );
        })(),
        (error: unknown) =>
          error instanceof PublicListenerBindingError &&
          error.stage === 'public_binding',
      )
      .finally(async () => {
        await started?.shutdown();
      });

    await until(
      () => log.pids().every((pid) => !isAlive(pid)),
      'every fixture process to end',
    );
  });
});

// ---------------------------------------------------------------------------
// Publish (T2.16)

describe('a publish', () => {
  test('that adds a bundle serves its DESKTOP methods without a restart; one that removes it answers UNIMPLEMENTED', async (t) => {
    const env = await boot(t, {});
    const port = publicPortOf(env.platform);
    const client = grpcOf(t, env.platform, ModelsService);

    assertFailure(
      await failureOf(client.kind({ id: 'k' })),
      Code.Unimplemented,
      'unknown_contract',
    );

    env.scripts.models = { mode: 'serve-models' };

    assert.deepEqual(
      await within(
        env.platform.publish(resolveHost({ models })),
        'the publish',
      ),
      { status: 'published', bundles: ['models'] },
    );
    assert.equal(await labelOf(client), 'g1');
    assert.equal(env.platform.publicPort, port, 'the same listener');

    assert.deepEqual(
      await within(env.platform.publish(resolveHost({})), 'the publish'),
      { status: 'published', bundles: ['models'] },
    );
    assertFailure(
      await failureOf(client.kind({ id: 'k' })),
      Code.Unimplemented,
      'unknown_contract',
    );
  });

  test('a call in flight to a draining instance finishes there; the next goes to the new generation', async (t) => {
    const env = await boot(t, { models: { ...models, ms: 1_000 } });
    const client = grpcOf(t, env.platform, ModelsService);
    const inFlight = labelOf(client, 'first');

    await until(
      () => env.log.countOf('models', 'call') === 1,
      'the call to reach generation 1',
    );

    env.scripts.models = { mode: 'serve-models' };
    env.digests.set('models', 'v2');

    assert.deepEqual(
      await within(
        env.platform.publish(resolveHost({ models })),
        'the publish',
      ),
      { status: 'published', bundles: ['models'] },
    );
    assert.equal(await inFlight, 'g1');
    assert.equal(await labelOf(client, 'second'), 'g2');
  });

  test('a proxied request and an upgraded connection in flight to a draining instance finish there', async (t) => {
    const env = await boot(t, { relay: { ...relay, ms: 1_000 } });
    const port = publicPortOf(env.platform);
    const connection = await upgrade(t, port, '/screen/ws', 'open');

    await until(
      () => connection.received().includes('g1:open'),
      'the upgrade to generation 1',
    );

    const slow = httpGet(port, '/screen/slow');

    await until(
      () => env.log.countOf('relay', 'request') === 1,
      'the request to reach generation 1',
    );

    env.scripts.relay = { mode: 'http-prefix' };
    env.digests.set('relay', 'v2');

    assert.deepEqual(
      await within(env.platform.publish(resolveHost({ relay })), 'the publish'),
      { status: 'published', bundles: ['relay'] },
    );
    assert.deepEqual(await slow, {
      status: 200,
      body: 'g1 GET /screen/slow',
    });

    connection.socket.write('still');
    await until(
      () => connection.received().includes('g1:still'),
      'the upgraded connection to stay on generation 1',
    );

    assert.equal(
      (await httpGet(port, '/screen/new')).body,
      'g2 GET /screen/new',
    );

    const [first] = env.log.pidsOf('relay');

    assert.ok(
      !env.log.lines().includes(`relay stopped ${first}`),
      'generation 1 keeps serving while the connection is open',
    );

    connection.socket.end();
    await until(
      () => env.log.lines().includes(`relay stopped ${first}`),
      'generation 1 to stop once the connection closed',
      4_000,
    );
  });

  test('the drain deadline destroys an upgraded connection still open', async (t) => {
    const env = await boot(t, { relay }, { drainDeadlineMs: 500 });
    const port = publicPortOf(env.platform);
    const connection = await upgrade(t, port, '/screen/ws', 'open');

    await until(
      () => connection.received().includes('g1:open'),
      'the upgrade to generation 1',
    );

    env.digests.set('relay', 'v2');

    await within(env.platform.publish(resolveHost({ relay })), 'the publish');
    await within(connection.closed, 'the drain deadline to close it', 4_000);
  });

  test('answering kernel_restart_required leaves the gateway as it was', async (t) => {
    const env = await boot(t, {});
    const client = grpcOf(t, env.platform, ModelsService);

    env.scripts.models = { mode: 'serve-models' };
    env.digests.set('core', 'v2');

    const result = await within(
      env.platform.publish(resolveHost({ models })),
      'the publish',
    );

    assert.equal(result.status, 'kernel_restart_required');
    assertFailure(
      await failureOf(client.kind({ id: 'k' })),
      Code.Unimplemented,
      'unknown_contract',
    );
    assert.equal(env.log.countOf('models', 'start'), 0);
  });
});
