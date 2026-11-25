// `doric:connect` in main (S64; spec `docs/designs/grpc-processes.md`, section
// 13, "The window to main"): the relay checks the sender, the window's pinned
// generation, `doric-client-part` and the method's exposure, fills
// `windowKey`, and forwards the bytes to the host. Driven through a window's
// Connect client whose `fetch` plays the preload; the host is a fake
// `HostForward`, the window's webContents a fake ipc sender.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { create, toBinary } from '@bufbuild/protobuf';
import { createClientPart, fromConnectError } from 'bundle/client';
import { scopeFromHeader, scopeHeaderValue } from 'bundle/contracts';
import {
  CatalogService,
  file_doric_platform_catalog_v1_catalog,
} from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import {
  CreateRequestSchema,
  CreateResponseSchema,
  file_doric_secrets_v1_secrets,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { createCatalogIndex } from 'bundle/platform';
import type { ConnectAnswer, ConnectRequest } from 'desktop/protocol';

import { generationView } from '../src/platform/bridge/client-routing';
import {
  type ConnectEvent,
  type ConnectRelay,
  createConnectRelay,
  type ForwardRequest,
} from '../src/platform/bridge/connect-relay';
import { resolveDistribution } from '../src/platform/catalog/resolve';
import {
  type WindowEntry,
  WindowRegistry,
} from '../src/platform/windows/registry';
import { fixtureDistribution } from './support/distribution';

// ---------------------------------------------------------------------------
// The generation: `settings` has a client part, `headless` none.

const { catalog } = fixtureDistribution({
  core: 'mincore',
  bundles: [
    { id: 'mincore', files: { 'desktop/index.js': '' } },
    { id: 'settings', files: { 'client/index.js': '' } },
    { id: 'headless', files: { 'desktop/index.js': '' } },
  ],
});

const index = createCatalogIndex([
  file_doric_secrets_v1_secrets,
  file_doric_platform_catalog_v1_catalog,
]);

const view = generationView({
  generation: 1,
  mode: 'connected',
  catalog,
  resolution: resolveDistribution(catalog, 1),
  read: () => undefined,
});

const created = toBinary(
  CreateResponseSchema,
  create(CreateResponseSchema, {
    credentialDescription: { id: 'c1', kind: 'GITHUB_TOKEN', name: 'gh' },
  }),
);

// ---------------------------------------------------------------------------
// Fakes

const fakeContents = (id: number, url: string) => ({
  id,
  mainFrame: undefined,
  getURL: () => url,
  reload: () => undefined,
  once: () => undefined,
  isDestroyed: () => false,
  send: () => undefined,
  postMessage: () => undefined,
});

const eventOf = (
  contents: ReturnType<typeof fakeContents>,
  url = contents.getURL(),
): ConnectEvent => ({ sender: contents, senderFrame: { url } }) as ConnectEvent;

let registry: WindowRegistry;
let forwarded: ForwardRequest[];
let relay: ConnectRelay;
let window: ReturnType<typeof fakeContents>;

beforeEach(() => {
  registry = new WindowRegistry();
  forwarded = [];
  window = fakeContents(11, 'doric://app/settings');

  const entry: WindowEntry = {
    key: 'workspace',
    kind: 'path',
    window: { webContents: window } as unknown as WindowEntry['window'],
    contents: window as unknown as WindowEntry['contents'],
    appearance: { titleBar: 'integrated', background: 'window' },
    primary: true,
    pinnedGeneration: 1,
    context: { path: null, focus: null },
  };

  registry.add(entry);
  relay = createConnectRelay({
    registry,
    view: (generation) => (generation === 1 ? view : undefined),
    index: (generation) => (generation === 1 ? index : undefined),
    forward: {
      request: async (input) => {
        forwarded.push(input);

        return {
          status: 200,
          headers: [['content-type', 'application/proto']],
          body: (async function* () {
            yield created;
          })(),
        };
      },
    },
  });
});

/** How the preload's request is changed on its way (a hostile window). */
interface Tamper {
  readonly drop?: readonly string[];
  readonly add?: readonly (readonly [string, string])[];
}

/** A `fetch` that hands each request to the relay as the preload would. */
const preloadFetch = (event: ConnectEvent, tamper: Tamper = {}) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, {
      ...init,
      duplex: 'half',
    } as RequestInit);
    const headers = [...request.headers]
      .filter(([name]) => !(tamper.drop ?? []).includes(name))
      .concat((tamper.add ?? []).map(([name, value]) => [name, value]));
    const raw: ConnectRequest = {
      path: new URL(request.url).pathname,
      headers: headers.map(([name, value]) => [name, value] as const),
      body: new Uint8Array(await request.arrayBuffer()),
    };
    const answer: ConnectAnswer = await relay.handle(event, raw);

    assert.ok('body' in answer, 'a unary call answers its whole response');

    return new Response(
      answer.body as ConstructorParameters<typeof Response>[0],
      {
        status: answer.status,
        headers: answer.headers.map(([name, value]) => [name, value]),
      },
    );
  }) as typeof globalThis.fetch;

/**
 * A window's client part over the relay (`bundle/client`, so that the
 * Connect classes are the window's: ESM, one instance).
 */
const partOf = (bundleId: string, tamper?: Tamper) =>
  createClientPart({
    bundleId,
    baseUrl: 'http://doric.window',
    fetch: preloadFetch(eventOf(window), tamper),
  });

const secrets = (bundleId: string, tamper?: Tamper) =>
  partOf(bundleId, tamper).use(SecretsService);

type ConnectFailure = Parameters<typeof fromConnectError>[0];

/** The Doric code the window's client reads from the call's failure. */
const doricCode = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    assert.equal(
      typeof (error as Partial<ConnectFailure>).findDetails,
      'function',
      `expected a ConnectError: ${error}`,
    );

    return fromConnectError(error as ConnectFailure).code;
  }

  return assert.fail('the call succeeded');
};

const headerOf = (request: ForwardRequest | undefined, name: string) =>
  request?.headers.find(([key]) => key.toLowerCase() === name)?.[1];

const credential = { kind: 'GITHUB_TOKEN', name: 'gh' };

// ---------------------------------------------------------------------------

describe('doric:connect relay', () => {
  test('a request without doric-client-part is refused with undeclared_requirement', async () => {
    const client = secrets('settings', { drop: ['doric-client-part'] });

    assert.equal(
      await doricCode(client.create(credential)),
      'undeclared_requirement',
    );
    assert.deepEqual(forwarded, []);
  });

  test('a bundle without an active client part in the pinned generation is refused with unavailable', async () => {
    for (const bundleId of ['headless', 'ghost']) {
      assert.equal(
        await doricCode(secrets(bundleId).create(credential)),
        'unavailable',
        bundleId,
      );
    }

    assert.deepEqual(forwarded, []);
  });

  test('a method not exposed to DESKTOP, or of a doric.* contract, is refused with unknown_contract', async () => {
    assert.equal(
      await doricCode(
        secrets('settings').resolve({ credentialRef: { id: 'c1' } }),
      ),
      'unknown_contract',
    );
    assert.equal(
      await doricCode(partOf('settings').use(CatalogService).get({})),
      'unknown_contract',
    );
    assert.deepEqual(forwarded, []);
  });

  test('a valid call is forwarded with the bytes unchanged, windowKey set and doric-caller* removed', async () => {
    const answer = await secrets('settings', {
      add: [
        ['doric-caller', 'core'],
        ['doric-caller-incarnation', '3'],
      ],
    }).create(credential, {
      headers: {
        'doric-scope-bin': scopeHeaderValue({
          projectId: 'p1',
          windowKey: 'forged',
        }),
      },
    });

    assert.equal(answer.credentialDescription?.id, 'c1');
    assert.equal(forwarded.length, 1);

    const [request] = forwarded;

    assert.equal(request?.path, '/doric.secrets.v1.SecretsService/Create');
    assert.deepEqual(
      request?.body,
      toBinary(CreateRequestSchema, create(CreateRequestSchema, credential)),
    );
    assert.equal(headerOf(request, 'doric-client-part'), 'settings');
    assert.deepEqual(
      { ...scopeFromHeader(headerOf(request, 'doric-scope-bin') ?? '') },
      { projectId: 'p1', windowKey: 'workspace' },
    );
    assert.deepEqual(
      (request?.headers ?? []).filter(([name]) =>
        name.toLowerCase().startsWith('doric-caller'),
      ),
      [],
    );
  });

  test('a call without a scope is forwarded with the window key as its scope', async () => {
    await secrets('settings').create(credential);

    assert.deepEqual(
      { ...scopeFromHeader(headerOf(forwarded[0], 'doric-scope-bin') ?? '') },
      { windowKey: 'workspace' },
    );
  });

  test('a sender that is not a known doric://app window is refused as doric:desktop refuses it', async () => {
    const stranger = fakeContents(99, 'doric://app/');
    const raw: ConnectRequest = {
      path: '/doric.secrets.v1.SecretsService/Create',
      headers: [
        ['content-type', 'application/proto'],
        ['doric-client-part', 'settings'],
      ],
      body: toBinary(
        CreateRequestSchema,
        create(CreateRequestSchema, credential),
      ),
    };

    for (const event of [
      eventOf(window, 'http://localhost:4200/'),
      eventOf(window, 'file:///Doric/doric-renderer/index.html'),
      eventOf(stranger),
    ]) {
      await assert.rejects(relay.handle(event, raw), {
        message: 'The request source is not allowed.',
      });
    }

    assert.deepEqual(forwarded, []);
  });
});
