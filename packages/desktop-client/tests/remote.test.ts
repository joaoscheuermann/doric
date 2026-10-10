import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractError,
  type Disposable,
  disposableSchema,
  functionSchema,
  ref,
  type Services,
  type StreamListener,
  streamListener,
} from 'bundle/contracts';
import { memberSchema } from 'bundle/runtime';
import { z } from 'zod';

import {
  activateClientBundles,
  type RemoteContract,
  remoteMethodSpecFromSchema,
} from '../src/index.js';
import {
  describe,
  type FakeDesktop,
  fakeDesktop,
  importerOf,
  windowCatalog,
} from './support/fixtures.js';

interface Probe {
  ping(text: string, call?: unknown): Promise<string>;
  watch(listener: StreamListener<number>, call?: unknown): Disposable;
  register(handler: () => void): Disposable;
}

const ProbeV1 = ref<Probe>('probe.api/v1');

const probe: RemoteContract = {
  id: 'probe.api/v1',
  environment: 'desktopMain',
  bundleId: 'probe',
  version: '1.0.0',
  contractVersion: '1.0.0',
  cardinality: 'one',
  methods: {
    ping: { tuple: 1, local: false, stream: false },
    watch: { tuple: 1, local: false, stream: true },
    register: { tuple: null, local: true, stream: false },
  },
};

/** Activates one client bundle and hands its services to the test. */
const clientOf = async (
  requires: readonly string[] = ['probe.api/v1@^1.0.0'],
): Promise<{ services: Services; desktop: FakeDesktop }> => {
  let services: Services | undefined;
  const bundles = [
    // The desktopMain provider of probe.api/v1 (no client part runs).
    {
      id: 'probe',
      provides: ['probe.api/v1@1.0.0'],
      contracts: [
        {
          id: 'probe.api/v1',
          version: '1.0.0',
          environment: 'desktopMain' as const,
        },
      ],
      noPart: true,
    },
    {
      id: 'app',
      requires,
      activate: ({ services: given }: { services: Services }) => {
        services = given;
      },
    },
  ];
  const description = describe({ key: 'probe:graph' });
  const catalog = windowCatalog(bundles, { core: 'probe', remote: [probe] });

  const desktop = fakeDesktop(description, catalog);

  await activateClientBundles({
    catalog,
    desktop,
    description,
    importPart: importerOf(bundles),
  });

  assert.ok(services !== undefined);

  return { services, desktop };
};

void test('a client call crosses the bridge as the calling bundle, without windowKey, and returns the output', async () => {
  const { services, desktop } = await clientOf();

  desktop.answer = async (envelope) => ({
    ok: true,
    output: `pong ${(envelope.input as string[])[0]}`,
  });

  const deadline = Date.now() + 10_000;
  const output = await services
    .use(ProbeV1, { projectId: 'p1', windowKey: 'forged' })
    .ping('hi', { deadline });
  const [envelope] = desktop.calls.filter(
    ({ contract }) => contract === 'probe.api/v1',
  );

  assert.equal(output, 'pong hi');
  assert.ok(envelope !== undefined);
  assert.deepEqual(
    {
      method: envelope.method,
      input: envelope.input,
      bundleId: envelope.bundleId,
      scope: envelope.scope,
      deadline: envelope.deadline,
    },
    {
      method: 'ping',
      input: ['hi'],
      bundleId: 'app',
      scope: { projectId: 'p1' },
      deadline,
    },
  );
  assert.match(envelope.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

void test('an error answer becomes the same ContractError', async () => {
  const { services, desktop } = await clientOf();

  desktop.answer = async () => ({
    ok: false,
    error: {
      code: 'unavailable',
      message: 'Doric backend is unavailable.',
      details: { contract: 'probe.api/v1' },
    },
  });

  await assert.rejects(services.use(ProbeV1).ping('hi'), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, 'unavailable');
    assert.equal(error.message, 'Doric backend is unavailable.');
    assert.deepEqual(error.details, { contract: 'probe.api/v1' });

    return true;
  });
});

void test('aborting a call sends cancel for its id', async () => {
  const { services, desktop } = await clientOf();
  let release: (() => void) | undefined;

  desktop.answer = () =>
    new Promise((resolve) => {
      release = () =>
        resolve({
          ok: false,
          error: { code: 'internal', message: 'The call was cancelled.' },
        });
    });

  const controller = new AbortController();
  const pending = services
    .use(ProbeV1)
    .ping('slow', { signal: controller.signal });

  controller.abort();
  release?.();
  await assert.rejects(pending);

  const [envelope] = desktop.calls.filter(
    ({ contract }) => contract === 'probe.api/v1',
  );

  assert.deepEqual(desktop.cancels, [envelope?.id]);
});

void test('a local method answers local_only without crossing', async () => {
  const { services, desktop } = await clientOf();

  assert.throws(
    () => services.use(ProbeV1).register(() => undefined),
    (error) => error instanceof ContractError && error.code === 'local_only',
  );
  assert.equal(
    desktop.calls.filter(({ contract }) => contract === 'probe.api/v1').length,
    0,
  );
});

void test('a contract outside requires is refused before reaching main', async () => {
  const { services, desktop } = await clientOf([]);

  assert.throws(
    () => services.use(ProbeV1),
    (error) =>
      error instanceof ContractError && error.code === 'undeclared_requirement',
  );
  assert.equal(desktop.calls.length, desktop.shell('diagnostic').length);
});

void test('a stream subscribes without the listener, delivers items, ends with the error and unsubscribes on dispose', async () => {
  const { services, desktop } = await clientOf();
  const items: number[] = [];
  const ends: (ContractError | undefined)[] = [];
  const subscription = services.use(ProbeV1).watch({
    next: (item) => items.push(item),
    end: (error) => ends.push(error),
  });
  const [entry] = desktop.subscriptions;

  assert.ok(entry !== undefined);
  assert.deepEqual(
    { method: entry.envelope.method, input: entry.envelope.input },
    { method: 'watch', input: [] },
  );
  assert.equal(entry.envelope.bundleId, 'app');

  desktop.push('probe.api/v1', 'watch', 1);
  desktop.push('probe.api/v1', 'watch', 2);
  entry.listener({
    type: 'end',
    error: { code: 'disconnected', message: 'The bridge disconnected.' },
  });
  desktop.push('probe.api/v1', 'watch', 3);

  assert.deepEqual(items, [1, 2]);
  assert.equal(ends.length, 1);
  assert.equal(ends[0]?.code, 'disconnected');

  const second = services.use(ProbeV1).watch((item) => items.push(item));
  const reopened = desktop.subscriptions[1];

  desktop.push('probe.api/v1', 'watch', 4);
  second.dispose();
  subscription.dispose();

  assert.deepEqual(items, [1, 2, 4]);
  assert.equal(reopened?.unsubscribed, true);
});

void test('method specs are read from the published JSON Schemas', () => {
  const schemaOf = (schema: z.ZodType, io: 'input' | 'output') =>
    memberSchema(schema, io).schema;
  const spec = (input: z.ZodType, output: z.ZodType) =>
    remoteMethodSpecFromSchema(
      schemaOf(input, 'input'),
      schemaOf(output, 'output'),
    );

  assert.deepEqual(spec(z.object({ id: z.string() }), z.string()), {
    tuple: null,
    local: false,
    stream: false,
  });
  assert.deepEqual(
    spec(z.tuple([z.string(), z.number().optional()]), z.void()),
    {
      tuple: 2,
      local: false,
      stream: false,
    },
  );
  assert.deepEqual(
    spec(z.tuple([z.string(), streamListener(z.number())]), disposableSchema),
    { tuple: 2, local: false, stream: true },
  );
  assert.equal(
    spec(z.tuple([functionSchema<() => void>()]), disposableSchema).local,
    true,
  );
});
