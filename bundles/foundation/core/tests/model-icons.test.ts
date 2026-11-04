import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ModelIconChoice,
  ModelIconRequest,
  ModelsProvider,
} from 'bundle/contracts';
import { modelIconSvg } from 'llms';

import { modelIcons } from '../src/host/models/icons.js';
import type { ConfiguredProvider } from '../src/host/models/providers.js';
import type { KindEntry } from '../src/host/models/registry.js';

// `modelIcons` (models/v1.icons) over fake provider records: the records are the
// boundary whose failures, delays and answers each case controls.

type IconsInput = Parameters<ModelsProvider['icons']>[0];

const unexpected = (): never => {
  throw new Error('Not used by icons.');
};

/** A provider record of `kind` whose `icons` answers as the case says. */
const record = (
  kind: string,
  icons: (input: IconsInput) => Promise<ModelIconChoice>,
): KindEntry => ({
  api: {
    kind: unexpected,
    advertised: unexpected,
    catalog: unexpected,
    create: unexpected,
    catalogCapacity: unexpected,
    icons: (input: IconsInput) => icons(input),
  },
  kind: {
    id: kind,
    label: kind,
    description: `The ${kind} kind.`,
    fields: [],
    lists: ['models'],
  },
  advertised: true,
  catalogCapacity: false,
});

/** A registry over fixed records, and a configuration of fixed providers. */
const world = (
  records: readonly KindEntry[],
  configured: readonly ConfiguredProvider[] = [],
) => ({
  registry: {
    find: (id: string) =>
      Promise.resolve(records.find((entry) => entry.kind.id === id)),
  },
  cache: { configured: () => configured },
});

const draft = (kind: string, models: readonly string[]): ModelIconRequest => ({
  kind,
  configuration: {},
  models: [...models],
});

void test('a provider record that rejects, answers another number of models or names an unknown icon gives its request no icon, and the call answers', async () => {
  const { registry, cache } = world([
    record('rejects', () => Promise.reject(new Error('boom'))),
    record('short', () =>
      Promise.resolve({ provider: 'claude', models: ['claude'] }),
    ),
    record('unknown', () =>
      Promise.resolve({ provider: 'anthropic', models: ['toString', null] }),
    ),
  ]);

  assert.deepEqual(
    await modelIcons(registry, cache, {
      requests: [
        draft('rejects', ['a', 'b']),
        draft('short', ['a', 'b']),
        draft('unknown', ['a', 'b']),
      ],
    }),
    {
      svgs: {},
      answers: [
        { models: [null, null] },
        { models: [null, null] },
        { models: [null, null] },
      ],
    },
  );
});

void test('a provider record that does not answer within the deadline gives its request no icon, and the other request still answers', async () => {
  const { registry, cache } = world([
    record('slow', () => new Promise<ModelIconChoice>(() => undefined)),
    record('fast', () =>
      Promise.resolve({ provider: 'claude', models: ['claude'] }),
    ),
  ]);

  assert.deepEqual(
    await modelIcons(
      registry,
      cache,
      { requests: [draft('slow', ['a']), draft('fast', ['b'])] },
      { deadlineMs: 20 },
    ),
    {
      svgs: { claude: modelIconSvg('claude') },
      answers: [{ models: [null] }, { provider: 'claude', models: ['claude'] }],
    },
  );
});

void test('a configured provider is asked with its kind and values, and an unknown id or kind answers no icon', async () => {
  const asked: IconsInput[] = [];
  const { registry, cache } = world(
    [
      record('openrouter', (input) => {
        asked.push(input);

        return Promise.resolve({ provider: 'openrouter', models: ['claude'] });
      }),
    ],
    [
      { id: 'or', kind: 'openrouter', configuration: { x: '1' } },
      { id: 'lost', kind: 'gone', configuration: {} },
    ],
  );

  const { answers } = await modelIcons(registry, cache, {
    requests: [
      { providerId: 'or', models: ['anthropic/claude-sonnet-4'] },
      { providerId: 'missing', models: ['m'] },
      { providerId: 'lost', models: ['m'] },
    ],
  });

  assert.deepEqual(asked, [
    { configuration: { x: '1' }, models: ['anthropic/claude-sonnet-4'] },
  ]);
  assert.deepEqual(answers, [
    { provider: 'openrouter', models: ['claude'] },
    { models: [null] },
    { models: [null] },
  ]);
});

void test("a model without its own icon wears its provider's own, and svgs holds exactly the names the answers use", async () => {
  const { registry, cache } = world([
    record('openrouter', () =>
      Promise.resolve({ provider: 'openrouter', models: ['claude', null] }),
    ),
  ]);

  const { svgs, answers } = await modelIcons(registry, cache, {
    requests: [draft('openrouter', ['anthropic/claude-sonnet-4', 'acme/x'])],
  });

  assert.deepEqual(answers, [
    { provider: 'openrouter', models: ['claude', 'openrouter'] },
  ]);
  assert.deepEqual(Object.keys(svgs).sort(), ['claude', 'openrouter']);
  assert.equal(svgs.claude, modelIconSvg('claude'));
  assert.equal(svgs.openrouter, modelIconSvg('openrouter'));
});
