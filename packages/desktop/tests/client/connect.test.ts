// The window's Connect path to the host (S64; spec
// `docs/designs/grpc-processes.md`, section 13, "The window to main" and "The
// window from phase 3 to phase 5"): `windowFetch` carries Connect requests
// over `doric:connect` (a unary call in one `request`, a stream's body on a
// `MessagePort`), `windowHostClients` gives each bundle its client part over
// it, and an activated client part's `services.use` of a generated `HOST`
// descriptor goes that way. The preload's `window.doric.connect` is the
// boundary every test fakes.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  type Client,
  Code,
  ConnectError,
  createClient,
} from '@connectrpc/connect';
import { createClientPartTransport } from 'bundle/client';
import type {
  ClientContext,
  ClientServices,
  ProviderInfo,
} from 'bundle/contracts';
import {
  CreateRequestSchema,
  CreateResponseSchema,
  SecretsService,
  WatchRedactionsResponseSchema,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';

import {
  activateClientBundles,
  type ConnectReply,
  type ConnectRequest,
  type DoricConnectApi,
  WINDOW_HOST_URL,
  windowFetch,
  windowHostClients,
} from '../../src/client/index.js';
import {
  asDocument,
  type ClientBundle,
  describe as describeWindow,
  fakeDesktop,
  fakeDocument,
  importerOf,
  settle,
  windowCatalog,
} from './support/fixtures.js';

// ---------------------------------------------------------------------------
// Helpers

/** A `window.doric.connect` that records every request and answers `reply`. */
const fakeConnect = (
  reply: (request: ConnectRequest) => Promise<ConnectReply> = async () =>
    unary(
      toBinary(
        CreateResponseSchema,
        create(CreateResponseSchema, {
          credentialDescription: { id: 'c1', kind: 'GITHUB_TOKEN', name: 'gh' },
        }),
      ),
    ),
) => {
  const requests: ConnectRequest[] = [];
  const api: DoricConnectApi = {
    request: async (request) => {
      requests.push(request);

      return reply(request);
    },
  };

  return { api, requests };
};

/** A whole unary Connect answer with a binary body. */
const unary = (body: Uint8Array): ConnectReply => ({
  status: 200,
  headers: [['content-type', 'application/proto']],
  body,
});

/** One Connect stream envelope: flags, a 4-byte big-endian length, data. */
const envelope = (flags: number, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(5 + data.byteLength);

  out[0] = flags;
  new DataView(out.buffer).setUint32(1, data.byteLength);
  out.set(data, 5);

  return out;
};

const redactions = (...values: string[]): Uint8Array =>
  envelope(
    0,
    toBinary(
      WatchRedactionsResponseSchema,
      create(WatchRedactionsResponseSchema, { redactions: values }),
    ),
  );

/** The end-of-stream envelope of a Connect stream that ends with `error`. */
const endWith = (error: { code: string; message: string }): Uint8Array =>
  envelope(2, new TextEncoder().encode(JSON.stringify({ error })));

const headerOf = (request: ConnectRequest | undefined, name: string) =>
  request?.headers.find(([key]) => key.toLowerCase() === name)?.[1];

const secretsOver = (
  api: DoricConnectApi,
  bundleId = 'settings',
): Client<typeof SecretsService> =>
  createClient(
    SecretsService,
    createClientPartTransport({
      bundleId,
      baseUrl: WINDOW_HOST_URL,
      fetch: windowFetch(api),
    }),
  );

/** The items a server stream delivered and the error that ended it. */
const drain = async (
  stream: AsyncIterable<{ redactions: string[] }>,
): Promise<{ items: string[][]; error: unknown }> => {
  const items: string[][] = [];

  try {
    for await (const item of stream) {
      items.push([...item.redactions]);
    }
  } catch (error) {
    return { items, error };
  }

  return { items, error: undefined };
};

// ---------------------------------------------------------------------------
// windowFetch

describe('windowFetch', () => {
  test('a unary call round-trips through one request: path, headers and binary body', async () => {
    const fake = fakeConnect();
    const answer = await secretsOver(fake.api).create({
      kind: 'GITHUB_TOKEN',
      name: 'gh',
    });

    assert.equal(answer.credentialDescription?.id, 'c1');
    assert.equal(fake.requests.length, 1);

    const [request] = fake.requests;

    assert.equal(request?.path, '/doric.secrets.v1.SecretsService/Create');
    assert.equal(headerOf(request, 'doric-client-part'), 'settings');
    assert.deepEqual(
      fromBinary(CreateRequestSchema, request?.body ?? new Uint8Array()),
      create(CreateRequestSchema, { kind: 'GITHUB_TOKEN', name: 'gh' }),
    );
  });

  test('a server stream delivers the items posted on its port in order and ends with the relayed error', async () => {
    const channel = new MessageChannel();
    const fake = fakeConnect(async () => {
      queueMicrotask(() => {
        channel.port2.postMessage(redactions('a'));
        channel.port2.postMessage(redactions('a', 'b'));
        channel.port2.postMessage(
          endWith({ code: 'not_found', message: 'the store is gone' }),
        );
        channel.port2.postMessage(null);
      });

      return {
        status: 200,
        headers: [['content-type', 'application/connect+proto']],
        port: channel.port1,
      };
    });

    try {
      const { items, error } = await drain(
        secretsOver(fake.api).watchRedactions({}),
      );

      assert.deepEqual(items, [['a'], ['a', 'b']]);
      assert.ok(error instanceof ConnectError, `${error}`);
      assert.equal(error.code, Code.NotFound);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  test('a port that closes before the end of the stream is UNAVAILABLE', async () => {
    const channel = new MessageChannel();
    const fake = fakeConnect(async () => {
      queueMicrotask(() => {
        channel.port2.postMessage(redactions('a'));
        setImmediate(() => channel.port2.close());
      });

      return {
        status: 200,
        headers: [['content-type', 'application/connect+proto']],
        port: channel.port1,
      };
    });

    try {
      const { items, error } = await drain(
        secretsOver(fake.api).watchRedactions({}),
      );

      assert.deepEqual(items, [['a']]);
      assert.ok(error instanceof ConnectError, `${error}`);
      assert.equal(error.code, Code.Unavailable);
    } finally {
      channel.port1.close();
    }
  });

  test('a dead channel is UNAVAILABLE', async () => {
    const fake = fakeConnect(async () => {
      throw new Error('An object could not be cloned.');
    });

    await assert.rejects(
      secretsOver(fake.api).create({ kind: 'GITHUB_TOKEN', name: 'gh' }),
      (error: unknown) =>
        error instanceof ConnectError && error.code === Code.Unavailable,
    );
  });
});

// ---------------------------------------------------------------------------
// windowHostClients

describe('windowHostClients', () => {
  const provider: ProviderInfo = { bundleId: 'secrets', version: '1.4.0' };
  const catalog = {
    ...windowCatalog([{ id: 'core' }], { core: 'core' }),
    hostProviders: { 'secrets/v1': provider },
  };

  test("a bundle's part sends its calls over doric:connect in its own name", async () => {
    const fake = fakeConnect();
    const clients = windowHostClients(fake.api, catalog);
    const part = clients.part('git');

    assert.equal(part.bundleId, 'git');
    assert.equal(clients.part('git'), part, 'one part per bundle id');
    assert.equal(fake.requests.length, 0, 'creating the part makes no call');

    await part.use(SecretsService).create({ kind: 'GITHUB_TOKEN', name: 'gh' });

    assert.equal(fake.requests.length, 1);
    assert.equal(headerOf(fake.requests[0], 'doric-client-part'), 'git');
  });

  test('provider answers the host provider the window catalog lists, and nothing for another contract', () => {
    const clients = windowHostClients(fakeConnect().api, catalog);

    assert.deepEqual(clients.provider('secrets/v1'), provider);
    assert.equal(clients.provider('files/v1'), undefined);
  });
});

// ---------------------------------------------------------------------------
// A client part's services (activateClientBundles)

describe('a client part over doric:connect', () => {
  const activate = async (
    bundles: readonly ClientBundle[],
    hostProviders: Readonly<Record<string, ProviderInfo>>,
    connect: DoricConnectApi,
  ) => {
    const description = describeWindow();
    const catalog = {
      ...windowCatalog(bundles, { core: 'core' }),
      hostProviders,
    };

    return await activateClientBundles({
      catalog,
      desktop: fakeDesktop(description, catalog),
      connect,
      description,
      document: asDocument(fakeDocument()),
      importPart: importerOf(bundles),
    });
  };

  const servicesOf = (context: ClientContext): ClientServices =>
    context.services as ClientServices;

  test('services.use of a generated HOST descriptor calls over doric:connect with the part as doric-client-part', async () => {
    const fake = fakeConnect();
    let created: Promise<unknown> | undefined;

    await activate(
      [
        { id: 'core', activate: () => undefined },
        {
          id: 'settings',
          activate: (context) => {
            created = servicesOf(context)
              .use(SecretsService)
              .create({ kind: 'GITHUB_TOKEN', name: 'gh' });
          },
        },
      ],
      {},
      fake.api,
    );

    await created;

    assert.equal(fake.requests.length, 1);
    assert.equal(
      fake.requests[0]?.path,
      '/doric.secrets.v1.SecretsService/Create',
    );
    assert.equal(headerOf(fake.requests[0], 'doric-client-part'), 'settings');
  });

  test('whenAvailable of a generated descriptor calls back once with the provider the generation lists', async () => {
    const provider: ProviderInfo = { bundleId: 'secrets', version: '1.4.0' };
    const seen: ProviderInfo[] = [];

    await activate(
      [
        { id: 'core', activate: () => undefined },
        {
          id: 'settings',
          activate: (context) => {
            servicesOf(context).whenAvailable(
              SecretsService,
              (_client, info) => {
                seen.push(info);
              },
            );
          },
        },
      ],
      { 'secrets/v1': provider },
      fakeConnect().api,
    );
    await settle();

    assert.deepEqual(seen, [provider]);
  });
});
