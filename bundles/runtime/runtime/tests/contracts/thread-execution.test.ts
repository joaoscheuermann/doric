import assert from 'node:assert/strict';
import test from 'node:test';

import { checkThreadExecution } from '../../src/contracts/execution.js';
import * as contracts from '../../src/contracts/index.js';
import {
  type ExecutionConfiguration,
  modelDefaultEffort,
  modelEfforts,
  modelStartEffort,
  resolveThreadExecution,
} from '../../src/contracts/index.js';

/*
 * runtime.threads/v1 1.7.0 (per-thread model, spec §1): the rule that says
 * which provider, model and effort a Thread runs on, the check a chosen
 * execution passes, and the efforts a configured model offers.
 */

type Provider = ExecutionConfiguration['providers'][number];

const defaultExecution = {
  providerId: 'router',
  model: 'default-model',
  effort: 'medium',
} as const;

const configuration = (
  providers: readonly Provider[],
  execution: ExecutionConfiguration['models']['execution'] = defaultExecution,
): ExecutionConfiguration => ({ providers, models: { execution } });

/** A provider that lists `m-1` with two efforts and `m-2` with none. */
const listing: Provider = {
  id: 'router',
  models: [
    { name: 'm-1', reasonings: ['low', 'high'], defaultEffort: 'low' },
    { name: 'm-2' },
  ],
};

const listed = configuration([listing]);

void test('T-1 a Thread with a stored, available execution resolves to exactly what it stores', () => {
  assert.deepEqual(
    resolveThreadExecution(
      { providerId: 'router', model: 'm-1', effort: 'high' },
      listed,
    ),
    {
      status: 'resolved',
      source: 'thread',
      providerId: 'router',
      model: 'm-1',
      effort: 'high',
    },
  );
});

void test('T-1 a stored execution without an effort resolves without one though the default has one', () => {
  const resolved = resolveThreadExecution(
    { providerId: 'router', model: 'm-1' },
    listed,
  );
  assert.deepEqual(resolved, {
    status: 'resolved',
    source: 'thread',
    providerId: 'router',
    model: 'm-1',
  });
  assert.equal('effort' in resolved, false);
});

void test('T-1 a stored effort the model does not list does not make the execution unavailable', () => {
  assert.deepEqual(
    resolveThreadExecution(
      { providerId: 'router', model: 'm-2', effort: 'xhigh' },
      listed,
    ),
    {
      status: 'resolved',
      source: 'thread',
      providerId: 'router',
      model: 'm-2',
      effort: 'xhigh',
    },
  );
});

void test('T-1 a stored provider the configuration lacks is unavailable with the provider issue and the stored values', () => {
  assert.deepEqual(
    resolveThreadExecution(
      { providerId: 'gone', model: 'm-1', effort: 'low' },
      listed,
    ),
    {
      status: 'unavailable',
      issue: 'provider',
      providerId: 'gone',
      model: 'm-1',
      effort: 'low',
    },
  );
});

void test('T-1 a stored model a listing provider no longer lists is unavailable with the model issue', () => {
  assert.deepEqual(
    resolveThreadExecution({ providerId: 'router', model: 'm-9' }, listed),
    {
      status: 'unavailable',
      issue: 'model',
      providerId: 'router',
      model: 'm-9',
    },
  );
});

void test('T-1 a provider without listed models resolves any stored model', () => {
  for (const provider of [{ id: 'router' }, { id: 'router', models: [] }]) {
    assert.deepEqual(
      resolveThreadExecution(
        { providerId: 'router', model: 'typed/by-hand', effort: 'low' },
        configuration([provider]),
      ),
      {
        status: 'resolved',
        source: 'thread',
        providerId: 'router',
        model: 'typed/by-hand',
        effort: 'low',
      },
      JSON.stringify(provider),
    );
  }
});

void test('T-1 a stored provider without a model is unavailable with the model issue and an empty model', () => {
  assert.deepEqual(resolveThreadExecution({ providerId: 'router' }, listed), {
    status: 'unavailable',
    issue: 'model',
    providerId: 'router',
    model: '',
  });
});

void test('T-1 a legacy Thread without values follows the workspace default', () => {
  assert.deepEqual(resolveThreadExecution({}, listed), {
    status: 'resolved',
    source: 'default',
    providerId: 'router',
    model: 'default-model',
    effort: 'medium',
  });
  const withoutEffort = resolveThreadExecution(
    {},
    configuration([listing], { providerId: 'router', model: 'default-model' }),
  );
  assert.deepEqual(withoutEffort, {
    status: 'resolved',
    source: 'default',
    providerId: 'router',
    model: 'default-model',
  });
});

void test('T-1 a legacy Thread with its own model and effort runs them on the default provider, unchecked', () => {
  assert.deepEqual(
    resolveThreadExecution({ model: 'unlisted', effort: 'xhigh' }, listed),
    {
      status: 'resolved',
      source: 'default',
      providerId: 'router',
      model: 'unlisted',
      effort: 'xhigh',
    },
  );
  assert.deepEqual(resolveThreadExecution({ model: 'legacy-model' }, listed), {
    status: 'resolved',
    source: 'default',
    providerId: 'router',
    model: 'legacy-model',
    effort: 'medium',
  });
  assert.deepEqual(
    resolveThreadExecution({ effort: 'high' }, configuration([])),
    {
      status: 'resolved',
      source: 'default',
      providerId: 'router',
      model: 'default-model',
      effort: 'high',
    },
  );
});

void test('T-2 checkThreadExecution names the provider, then the model, then the effort a configuration refuses', () => {
  const cases: readonly (readonly [
    string,
    ExecutionConfiguration,
    contracts.ThreadExecution,
    contracts.ThreadExecutionIssue | undefined,
  ])[] = [
    [
      'a provider the configuration lacks',
      listed,
      { providerId: 'gone', model: 'm-9', effort: 'xhigh' },
      'provider',
    ],
    [
      'a model the listing provider does not list',
      listed,
      { providerId: 'router', model: 'm-9', effort: 'xhigh' },
      'model',
    ],
    [
      'an effort the model does not list',
      listed,
      { providerId: 'router', model: 'm-1', effort: 'xhigh' },
      'effort',
    ],
    [
      'an effort on a model listing an empty reasonings',
      configuration([
        { id: 'router', models: [{ name: 'm-1', reasonings: [] }] },
      ]),
      { providerId: 'router', model: 'm-1', effort: 'low' },
      'effort',
    ],
    [
      'an effort on a model without reasonings',
      listed,
      { providerId: 'router', model: 'm-2', effort: 'high' },
      undefined,
    ],
    [
      'any model and effort on a provider without models',
      configuration([{ id: 'router' }]),
      { providerId: 'router', model: 'typed', effort: 'xhigh' },
      undefined,
    ],
    [
      'any model and effort on a provider with an empty model list',
      configuration([{ id: 'router', models: [] }]),
      { providerId: 'router', model: 'typed', effort: 'xhigh' },
      undefined,
    ],
    [
      'a listed model and effort',
      listed,
      { providerId: 'router', model: 'm-1', effort: 'high' },
      undefined,
    ],
    [
      'a listed model with an empty reasonings and no effort',
      configuration([
        { id: 'router', models: [{ name: 'm-1', reasonings: [] }] },
      ]),
      { providerId: 'router', model: 'm-1' },
      undefined,
    ],
  ];
  for (const [what, config, execution, issue] of cases)
    assert.equal(checkThreadExecution(config, execution), issue, what);
});

void test('T-2 the public contracts do not export checkThreadExecution', () => {
  assert.equal('checkThreadExecution' in contracts, false);
  assert.deepEqual(
    [...contracts.threadExecutionIssues],
    ['provider', 'model', 'effort'],
  );
});

/** One provider `openai` listing `gpt-5` as given. */
const offering = (
  entry: NonNullable<Provider['models']>[number],
): ExecutionConfiguration => configuration([{ id: 'openai', models: [entry] }]);

const efforts = (config: ExecutionConfiguration, model = 'gpt-5') => ({
  efforts: modelEfforts(config, 'openai', model),
  defaultEffort: modelDefaultEffort(config, 'openai', model),
  startEffort: modelStartEffort(config, 'openai', model),
});

void test('T-3 a model whose catalog names a default offers its efforts and starts at that default', () => {
  assert.deepEqual(
    efforts(
      offering({
        name: 'gpt-5',
        reasonings: ['high', 'medium', 'low'],
        defaultEffort: 'high',
      }),
    ),
    {
      efforts: ['high', 'medium', 'low'],
      defaultEffort: 'high',
      startEffort: 'high',
    },
  );
});

void test('T-3 a model whose catalog default is none starts at its first effort other than none', () => {
  assert.deepEqual(
    efforts(
      offering({
        name: 'gpt-5',
        reasonings: ['none', 'low'],
        defaultEffort: 'none',
      }),
    ),
    { efforts: ['none', 'low'], defaultEffort: 'none', startEffort: 'low' },
  );
});

void test('T-3 a model without a catalog default starts at its first effort other than none', () => {
  assert.deepEqual(
    efforts(offering({ name: 'gpt-5', reasonings: ['none', 'low', 'high'] })),
    {
      efforts: ['none', 'low', 'high'],
      defaultEffort: undefined,
      startEffort: 'low',
    },
  );
});

void test('T-3 a model that offers only none starts at none', () => {
  assert.deepEqual(efforts(offering({ name: 'gpt-5', reasonings: ['none'] })), {
    efforts: ['none'],
    defaultEffort: undefined,
    startEffort: 'none',
  });
});

void test('T-3 a catalog default the model does not list is no default, and the model starts at its first effort', () => {
  assert.deepEqual(
    efforts(
      offering({
        name: 'gpt-5',
        reasonings: ['medium'],
        defaultEffort: 'high',
      }),
    ),
    { efforts: ['medium'], defaultEffort: undefined, startEffort: 'medium' },
  );
});

void test('T-3 a model without reasonings offers no effort and starts without one', () => {
  assert.deepEqual(
    efforts(offering({ name: 'gpt-5', defaultEffort: 'high' })),
    { efforts: [], defaultEffort: undefined, startEffort: undefined },
  );
});

void test('T-3 a model the provider does not list, or a provider the configuration lacks, offers no effort', () => {
  const config = offering({
    name: 'gpt-5',
    reasonings: ['low', 'high'],
    defaultEffort: 'low',
  });
  const none = {
    efforts: [],
    defaultEffort: undefined,
    startEffort: undefined,
  };
  assert.deepEqual(efforts(config, 'gpt-5-mini'), none);
  assert.deepEqual(
    {
      efforts: modelEfforts(config, 'gone', 'gpt-5'),
      defaultEffort: modelDefaultEffort(config, 'gone', 'gpt-5'),
      startEffort: modelStartEffort(config, 'gone', 'gpt-5'),
    },
    none,
  );
});

void test('T-3 an effort the runtime does not know is not offered', () => {
  assert.deepEqual(
    efforts(
      offering({
        name: 'gpt-5',
        reasonings: ['ultra', 'low', 'high'],
        defaultEffort: 'ultra',
      }),
    ),
    { efforts: ['low', 'high'], defaultEffort: undefined, startEffort: 'low' },
  );
});
