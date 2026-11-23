// The SDKs' side of the gateway (spec `docs/designs/grpc-processes.md`,
// section 10, `bundle/client` and `httpServer`; section 11, "The calling
// client part" and "The HTTP prefix"; D34): a client part's calls through
// `bundle/client` reach a running platform's public listener, checked against
// the part's own `client.requires`, and a host part's `httpServer` given to
// `runBundle` serves its HTTP prefix through the gateway. Each bundle is a
// process of the fixture `tests/fixtures/scripted`.

import assert from 'node:assert/strict';
import http from 'node:http';
import test, { describe, type TestContext } from 'node:test';

import { Code, ConnectError } from '@connectrpc/connect';

import {
  file_doric_models_v1_models,
  ModelsService,
} from '../../src/contracts/gen/doric/models/v1/models_pb.js';
import { file_doric_settings_v1_settings } from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import {
  file_doric_tools_v1_tools,
  ToolsService,
} from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import type { Platform } from '../../src/platform/index.js';
import {
  createClientPart,
  fromConnectError,
} from '../../src/sdk/client/index.js';
import {
  type FixtureBundle,
  type PlatformHost,
  setupPlatform,
  within,
} from '../support/scripted-host.js';

// ---------------------------------------------------------------------------
// Helpers

const index = createCatalogIndex([
  file_doric_tools_v1_tools,
  file_doric_settings_v1_settings,
  file_doric_models_v1_models,
]);

/** Boots `bundles` with a public listener on `127.0.0.1:0`. */
const boot = (
  t: TestContext,
  bundles: Readonly<Record<string, FixtureBundle>>,
): Promise<PlatformHost> =>
  setupPlatform(t, bundles, { publicAddress: '127.0.0.1:0', index });

const publicPortOf = (platform: Platform): number => {
  const port = platform.publicPort;

  assert.equal(typeof port, 'number', 'the platform has a public port');

  return port as number;
};

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

// ---------------------------------------------------------------------------
// bundle/client through the gateway

describe('a client part through bundle/client', () => {
  test('a contract its client.requires lists answers; one it does not is PERMISSION_DENIED undeclared_requirement', async (t) => {
    const env = await boot(t, {
      models: {
        mode: 'serve-models',
        provides: ['models/v1@1.0.0'],
        clientRequires: ['models/v1@^1.0.0'],
      },
    });
    const part = createClientPart({
      bundleId: 'models',
      baseUrl: `http://127.0.0.1:${publicPortOf(env.platform)}`,
    });
    const response = await within(
      part.use(ModelsService).kind({ id: 'k' }),
      'kind',
      4_000,
    );

    assert.equal(response.modelKindDescriptor?.label, 'g1');
    assert.equal(env.log.countOf('models', 'call'), 1);

    const error = await failureOf(part.use(ToolsService).catalog({}));

    assert.equal(
      fromConnectError(error).code,
      'undeclared_requirement',
      error.message,
    );
    assert.equal(error.code, Code.PermissionDenied, error.message);
  });
});

// ---------------------------------------------------------------------------
// runBundle's httpServer behind the gateway

describe("runBundle's httpServer", () => {
  test('serves the HTTP prefix through the gateway: the Hello carried its bound port', async (t) => {
    const env = await boot(t, {
      relay: { mode: 'http-server', httpPrefix: '/screen/' },
    });

    assert.deepEqual(
      await httpGet(publicPortOf(env.platform), '/screen/a/b?c=1'),
      { status: 200, body: 'g1 GET /screen/a/b?c=1' },
    );
    assert.equal(env.log.countOf('relay', 'request'), 1);
  });
});
