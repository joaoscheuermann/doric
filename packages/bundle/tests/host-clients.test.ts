// A window's services over Connect (S64; spec `docs/designs/grpc-processes.md`,
// section 13, "The window from phase 3 to phase 5"): with
// `ServiceRuntime.hostClients`, `services.use` of a `HOST` contract's
// generated descriptor answers a Connect client over the part's window
// transport, and `whenAvailable` of one calls back once when the window's
// generation lists a provider; a `ref<T>()` stays on the envelope. The window
// transport's `fetch` is the boundary the tests fake.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { create, type DescMessage, toBinary } from '@bufbuild/protobuf';
import { z } from 'zod';

import {
  type ClientServices,
  defineMethod,
  defineService,
  isContractError,
  type ProviderInfo,
  ref,
} from '../src/contracts/index.js';
import { scopeFromHeader, scopeHeader } from '../src/contracts/metadata.js';
import {
  createPrincipal,
  emptyCatalogView,
  type HostClients,
  ServiceDirectory,
  type ServiceRuntime,
} from '../src/runtime/index.js';
import { type ClientPart, createClientPart } from '../src/sdk/client/index.js';
import {
  type DemoClient,
  demoFile,
  serviceOf,
} from './support/demo-contract.js';

// ---------------------------------------------------------------------------
// Helpers

const file = demoFile({ id: 'demo/v1', package: 'demo.v1' });
const DemoService = serviceOf(file, 'DemoService');

const messageOf = (name: string): DescMessage => {
  const found = file.messages.find((message) => message.name === name);

  assert.ok(found !== undefined, name);

  return found;
};

const ResponseSchema = messageOf('Response');

/** One request the window transport sent. */
interface Sent {
  readonly url: string;
  readonly headers: Headers;
}

/**
 * Host clients over a fake window `fetch` that answers every unary call
 * with `Response { text: "ok" }`; `parts` lists the bundle ids `part` was
 * asked for, `sent` every request.
 */
const fakeHostClients = (
  providers: Readonly<Record<string, ProviderInfo>> = {},
) => {
  const sent: Sent[] = [];
  const parts: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, {
      ...init,
      duplex: 'half',
    } as RequestInit);

    sent.push({ url: request.url, headers: request.headers });
    await request.arrayBuffer();

    return new Response(
      toBinary(ResponseSchema, create(ResponseSchema, { text: 'ok' })),
      { status: 200, headers: { 'content-type': 'application/proto' } },
    );
  }) as typeof globalThis.fetch;
  const cache = new Map<string, ClientPart>();
  const hostClients: HostClients = {
    part: (bundleId) => {
      parts.push(bundleId);

      let part = cache.get(bundleId);

      if (part === undefined) {
        part = createClientPart({
          bundleId,
          baseUrl: 'http://doric.window',
          fetch,
        });
        cache.set(bundleId, part);
      }

      return part;
    },
    provider: (contractId) => providers[contractId],
  };

  return { sent, parts, hostClients };
};

const setup = (hostClients?: HostClients) => {
  const controller = new AbortController();
  const runtime: ServiceRuntime = {
    directory: new ServiceDirectory(),
    catalog: emptyCatalogView,
    environment: 'client',
    generation: 3,
    generationSignal: controller.signal,
    report: () => undefined,
    ...(hostClients === undefined ? {} : { hostClients }),
  };
  const services = (bundleId: string): ClientServices =>
    createPrincipal(runtime, {
      bundleId,
      version: '1.0.0',
      provides: 'any',
      requires: 'any',
    }).services as ClientServices;

  return { runtime, services };
};

/** Lets every pending task and microtask run. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const demo = (client: unknown): DemoClient => client as DemoClient;

// ---------------------------------------------------------------------------
// use

describe('ClientServices.use of a generated descriptor', () => {
  test("answers a client whose calls go through the calling bundle's part, making no call itself", async () => {
    const fake = fakeHostClients();
    const { services } = setup(fake.hostClients);
    const client = demo(services('chat').use(DemoService));

    assert.equal(fake.sent.length, 0, 'use made no call');
    assert.equal((await client.echo({ text: 'a' })).text, 'ok');
    assert.deepEqual(
      fake.parts.filter((id) => id !== 'chat'),
      [],
    );
    assert.equal(fake.sent.length, 1);
    assert.equal(
      new URL(fake.sent[0]?.url ?? '').pathname,
      '/demo.v1.DemoService/Echo',
    );
    assert.equal(fake.sent[0]?.headers.get('doric-client-part'), 'chat');
  });

  test('every call of a client used with a scope carries it in doric-scope-bin', async () => {
    const fake = fakeHostClients();
    const { services } = setup(fake.hostClients);
    const client = demo(
      services('files').use(DemoService, { projectId: 'p1' }),
    );

    await client.echo({ text: 'a' });

    const value = fake.sent[0]?.headers.get(scopeHeader) ?? null;

    assert.ok(value !== null, 'the call carries doric-scope-bin');
    assert.deepEqual({ ...scopeFromHeader(value) }, { projectId: 'p1' });
  });

  test('without host clients, use of a generated descriptor throws unavailable', () => {
    const { services } = setup();

    assert.throws(
      () => services('chat').use(DemoService),
      (error: unknown) =>
        isContractError(error) && error.code === 'unavailable',
    );
  });

  test('a ref<T>() still answers the envelope stub of its directory provider', async () => {
    const fake = fakeHostClients();
    const { services } = setup(fake.hostClients);
    const echo = defineService('alpha.echo/v1', {
      say: defineMethod({
        input: z.string(),
        output: z.object({ text: z.string() }),
        execute: (text) => ({ text }),
      }),
    });
    const EchoV1 = ref<typeof echo>('alpha.echo/v1');

    services('alpha').provide(echo);

    assert.deepEqual(await services('chat').use(EchoV1).say('hi'), {
      text: 'hi',
    });
    assert.equal(fake.sent.length, 0, 'nothing went over the window transport');
  });
});

// ---------------------------------------------------------------------------
// whenAvailable

describe('ClientServices.whenAvailable of a generated descriptor', () => {
  const provider: ProviderInfo = { bundleId: 'demo-host', version: '2.1.0' };

  test('calls back once, after the current task, when the generation lists a provider', async () => {
    const fake = fakeHostClients({ 'demo/v1': provider });
    const { services } = setup(fake.hostClients);
    const seen: { client: DemoClient; provider: ProviderInfo }[] = [];

    services('chat').whenAvailable(DemoService, (client, info) => {
      seen.push({ client: demo(client), provider: info });
    });

    assert.equal(seen.length, 0, 'not called synchronously');

    await settle();

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.provider, provider);
    assert.equal((await seen[0]?.client.echo({ text: 'a' }))?.text, 'ok');
    assert.equal(fake.sent[0]?.headers.get('doric-client-part'), 'chat');
  });

  test('never calls back when the generation lists no provider of the contract', async () => {
    const fake = fakeHostClients({});
    const { services } = setup(fake.hostClients);
    let calls = 0;

    services('chat').whenAvailable(DemoService, () => {
      calls += 1;
    });
    await settle();

    assert.equal(calls, 0);
  });

  test('disposing before the callback runs cancels it', async () => {
    const fake = fakeHostClients({ 'demo/v1': provider });
    const { services } = setup(fake.hostClients);
    let calls = 0;

    services('chat')
      .whenAvailable(DemoService, () => {
        calls += 1;
      })
      .dispose();
    await settle();

    assert.equal(calls, 0);
  });

  test('disposing after the callback ran runs its cleanup', async () => {
    const fake = fakeHostClients({ 'demo/v1': provider });
    const { services } = setup(fake.hostClients);
    let cleaned = 0;
    const registration = services('chat').whenAvailable(
      DemoService,
      () => () => {
        cleaned += 1;
      },
    );

    await settle();
    registration.dispose();
    await settle();

    assert.equal(cleaned, 1);
  });
});
