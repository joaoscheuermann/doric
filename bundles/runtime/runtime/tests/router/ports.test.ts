// `routedPorts` (phase 3, slice S46a, contract §1.5): each port of
// `RuntimePorts` keeps today's contract over `context.services`. Tests 27–30
// of the slice.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import { storageClient } from 'storage/rpc';

import type { DoricConfiguration } from '../../src/contracts/configuration.js';
import type { RuntimePorts } from '../../src/host/ports.js';
import { routedPorts } from '../../src/host/routed.js';
import {
  assertFails,
  callsOf,
  contextHarness,
  type HarnessOptions,
  within,
} from './support.js';

const TOKEN = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000007';

const noHooks: RuntimePorts['hooks'] = {
  projectReady: () => undefined,
  projectClosing: () => undefined,
};

const portsOf = async (
  t: Parameters<typeof contextHarness>[0],
  options: HarnessOptions = {},
) => {
  const { calls, context, external } = await contextHarness(t, options);
  const ports = routedPorts(
    context,
    storageClient(context.services.use(StorageService)),
    noHooks,
    external,
  );

  return { calls, ports };
};

/** A configuration with an empty `models` list and a model without reasonings. */
const configured: DoricConfiguration = {
  configuration: {
    providers: [
      {
        id: 'openrouter',
        kind: 'openrouter',
        configuration: { endpoint: 'https://openrouter.ai/api/v1', token: TOKEN },
        models: [{ name: 'deepseek/deepseek-v4', reasonings: [] }],
      },
      {
        id: 'local',
        kind: 'openai',
        configuration: { endpoint: 'http://localhost:1234/v1' },
        models: [],
      },
    ],
    models: {
      execution: { providerId: 'openrouter', model: 'deepseek/deepseek-v4' },
    },
    execution: { maxTurns: 32 },
    tools: {},
  },
  revision: 4,
  updatedAt: '2026-11-23T12:00:00.000Z',
} as unknown as DoricConfiguration;

describe('routedPorts', () => {
  test("27: configuration() decodes host-config/v1.Current to today's DoricConfiguration, empty models and reasonings as []", async (t) => {
    const { calls, ports } = await portsOf(t, {
      configuration: () => configured,
    });

    assert.deepEqual(callsOf({ calls }, 'hostConfig.current'), []);
    const configuration = await within(ports.configuration(), 'configuration');

    assert.deepEqual(configuration, configured);
    assert.deepEqual(callsOf({ calls }, 'hostConfig.current'), [{}]);
  });

  test('28: credentials.byId of a missing id rejects with credential_missing; byUnclaimedKind sends exclude', async (t) => {
    const secret = { id: OTHER, kind: 'API_TOKEN', name: 'GitHub', secret: 's' };
    const { calls, ports } = await portsOf(t, {
      byKind: (kind, exclude) =>
        kind === 'API_TOKEN' && !exclude.includes(OTHER) ? secret : undefined,
    });

    await assertFails(
      ports.credentials.byId('00000000-0000-4000-8000-00000000dead'),
      'credential_missing',
    );

    const found = await within(
      ports.credentials.byUnclaimedKind('API_TOKEN', new Set([TOKEN])),
      'byUnclaimedKind',
    );
    assert.equal(found?.id, OTHER);
    assert.equal(found?.secret, 's');
    assert.deepEqual(callsOf({ calls }, 'secrets.resolveByKind'), [
      { kind: 'API_TOKEN', exclude: [TOKEN] },
    ]);
  });

  test("29: claimedCredentials answers the secret fields' values of the configured providers (models/v1.Kind)", async (t) => {
    const { calls, ports } = await portsOf(t, {
      kinds: {
        openrouter: {
          id: 'openrouter',
          label: 'OpenRouter',
          description: 'OpenRouter',
          fields: [
            { key: 'endpoint', label: 'Endpoint', kind: 'url', required: true },
            { key: 'token', label: 'Token', kind: 'secret', required: true },
          ],
          lists: ['models'],
        },
      },
    });

    const claimed = await within(
      ports.claimedCredentials(configured.configuration),
      'claimedCredentials',
    );

    assert.deepEqual([...claimed], [TOKEN]);
    assert.deepEqual(callsOf({ calls }, 'models.kind'), [
      { id: 'openrouter' },
      { id: 'openai' },
    ]);
  });

  test('30: catalogSource(id).models() answers {id, contextWindow?} from models/v1.Models', async (t) => {
    const { calls, ports } = await portsOf(t, {
      models: {
        openrouter: [
          { id: 'deepseek/deepseek-v4', name: 'DeepSeek', contextWindow: 128000 },
          { id: 'tiny/model' },
        ],
      },
    });

    const source = await within(
      ports.catalogSource('openrouter', 'deepseek/deepseek-v4'),
      'catalogSource',
    );
    const models = await within(source.models(), 'models()');

    assert.deepEqual(models, [
      { id: 'deepseek/deepseek-v4', contextWindow: 128000 },
      { id: 'tiny/model' },
    ]);
    assert.deepEqual(callsOf({ calls }, 'models.models'), [
      { providerId: 'openrouter' },
    ]);
  });
});
