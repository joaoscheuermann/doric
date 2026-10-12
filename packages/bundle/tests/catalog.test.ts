import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type CatalogCandidate,
  type Composition,
  manifestV1Schema,
  type ResolvedEnvironment,
  resolveEnvironment,
} from '../src/runtime/index.js';
import {
  type ContractShape,
  descriptorFor,
  type ManifestOptions,
  manifest,
} from './support/fixtures.js';

const basics = ['hooks/v1@1.0.0', 'tools/v1@1.0.0', 'skills/v1@1.0.0'];

const candidate = (
  id: string,
  options: ManifestOptions & {
    readonly shapes?: Readonly<
      Record<string, ContractShape | readonly ContractShape[]>
    >;
    readonly embedded?: boolean;
  } = {},
): CatalogCandidate => {
  const source = manifest(id, options);

  return {
    id,
    source:
      options.embedded === true
        ? { kind: 'embedded' }
        : { kind: 'installed', dir: `/bundles/${id}` },
    manifest: manifestV1Schema.parse(source),
    descriptor: descriptorFor(source, options.shapes),
    errors: [],
  };
};

const core = (options: ManifestOptions = {}) =>
  candidate('core', { provides: basics, ...options });

const resolve = (
  candidates: readonly CatalogCandidate[],
  composition: Partial<Composition> = {},
  environment: 'host' | 'client' = 'host',
): ResolvedEnvironment =>
  resolveEnvironment(
    {
      candidates,
      composition: {
        core: 'core',
        enabled: candidates.map(({ id }) => id),
        providers: {},
        ...composition,
      },
      platformVersion: '1.0.0',
      generation: 1,
    },
    environment,
  );

const entry = (resolved: ResolvedEnvironment, id: string) => {
  const found = resolved.entries.find((item) => item.id === id);

  assert.ok(found, `entry ${id}`);

  return found;
};

const codes = (resolved: ResolvedEnvironment, id: string) =>
  entry(resolved, id).reasons.map(({ code }) => code);

void test('activates unrelated bundles in lexical order after core', () => {
  const resolved = resolve([candidate('z'), core(), candidate('a')]);

  assert.deepEqual(resolved.order, ['core', 'a', 'z']);
  assert.equal(entry(resolved, 'core').phase, 'core');
  assert.equal(entry(resolved, 'a').phase, 'others');
  assert.equal(resolved.recovery, undefined);
});

void test('activates a dependency before its consumer regardless of name', () => {
  const resolved = resolve([
    core(),
    candidate('alpha', { requires: ['zeta.api/v1@^1.0.0'] }),
    candidate('zeta', { provides: ['zeta.api/v1@1.2.0'] }),
  ]);

  assert.deepEqual(resolved.order, ['core', 'zeta', 'alpha']);
  assert.deepEqual(entry(resolved, 'alpha').dependencies, ['zeta']);
});

void test('lists installed bundles that are not enabled as disabled', () => {
  const resolved = resolve([core(), candidate('extra')], {
    enabled: ['core'],
  });

  assert.equal(entry(resolved, 'extra').state, 'disabled');
  assert.deepEqual(resolved.order, ['core']);
});

void test('reports an enabled bundle that is not installed', () => {
  const resolved = resolve([core()], { enabled: ['core', 'ghost'] });

  assert.ok(resolved.issues.includes('missing bundle ghost'));
});

void test('quarantines the second bundle with an existing ID', () => {
  const resolved = resolve([core(), candidate('git'), candidate('git')]);
  const states = resolved.entries
    .filter(({ id }) => id === 'git')
    .map(({ state, reasons }) => [state, reasons.map(({ code }) => code)]);

  assert.deepEqual(states, [
    ['scheduled', []],
    ['quarantined', ['duplicate_id']],
  ]);
});

void test('quarantines bundles whose platform range is not satisfied', () => {
  const resolved = resolve([
    core(),
    candidate('future', { engines: '^2.0.0' }),
  ]);

  assert.deepEqual(codes(resolved, 'future'), ['engines_unsatisfied']);
});

void test('quarantines bundles whose descriptor disagrees with provides', () => {
  const source = manifest('git', { provides: ['git.commands/v1@1.3.0'] });
  const mismatched: CatalogCandidate = {
    id: 'git',
    source: { kind: 'installed', dir: '/bundles/features/git' },
    manifest: manifestV1Schema.parse(source),
    descriptor: {
      ...descriptorFor(source),
      contracts: descriptorFor(source).contracts.map((contract) => ({
        ...contract,
        version: '1.2.0',
      })),
    },
    errors: [],
  };
  const withoutDescriptor: CatalogCandidate = {
    ...candidate('files'),
    descriptor: undefined,
  };
  const resolved = resolve([core(), mismatched, withoutDescriptor]);

  assert.deepEqual(codes(resolved, 'git'), ['invalid_descriptor']);
  assert.deepEqual(codes(resolved, 'files'), ['invalid_descriptor']);
});

void test('quarantines missing, incompatible and quarantined dependencies, cascading', () => {
  const resolved = resolve([
    core(),
    candidate('git', { version: '1.4.0', provides: ['git.commands/v1@1.3.0'] }),
    candidate('needs-new-git', { requires: ['git.commands/v1@^1.4.0'] }),
    candidate('needs-ghost', { requires: ['ghost.api/v1@^1.0.0'] }),
    candidate('chain', {
      provides: ['chain.api/v1@1.0.0'],
      requires: ['ghost.api/v1@^1.0.0'],
    }),
    candidate('end', { requires: ['chain.api/v1@^1.0.0'] }),
  ]);

  assert.deepEqual(codes(resolved, 'needs-new-git'), ['incompatible_version']);
  assert.equal(
    entry(resolved, 'needs-new-git').reasons[0]?.message,
    'requires git.commands/v1@^1.4.0; active 1.3.0 (git 1.4.0)',
  );
  assert.deepEqual(codes(resolved, 'needs-ghost'), ['missing_dependency']);
  assert.deepEqual(codes(resolved, 'chain'), ['missing_dependency']);
  assert.deepEqual(codes(resolved, 'end'), ['dependency_quarantined']);
  assert.deepEqual(resolved.order, ['core', 'git']);
});

void test('quarantines the members of a requires cycle and what depends on them', () => {
  const resolved = resolve([
    core(),
    candidate('left', {
      provides: ['left.api/v1@1.0.0'],
      requires: ['right.api/v1@^1.0.0'],
    }),
    candidate('right', {
      provides: ['right.api/v1@1.0.0'],
      requires: ['left.api/v1@^1.0.0'],
    }),
    candidate('user', { requires: ['left.api/v1@^1.0.0'] }),
    candidate('free'),
  ]);

  assert.deepEqual(codes(resolved, 'left'), ['dependency_cycle']);
  assert.deepEqual(codes(resolved, 'right'), ['dependency_cycle']);
  assert.deepEqual(codes(resolved, 'user'), ['dependency_quarantined']);
  assert.deepEqual(resolved.order, ['core', 'free']);
});

void test('does not constrain the host part with a contract provided only elsewhere', () => {
  const resolved = resolve([
    core(),
    candidate('ui', {
      provides: ['ui.panel/v1@1.0.0'],
      shapes: { 'ui.panel/v1': { environment: 'client' } },
    }),
    // Would be incompatible (provider 1.0.0) if the client provider constrained the host.
    candidate('host-user', { requires: ['ui.panel/v1@^1.5.0'] }),
  ]);

  assert.equal(entry(resolved, 'host-user').state, 'scheduled');
  assert.deepEqual(entry(resolved, 'host-user').dependencies, []);
});

void test('satisfies a client part with a host provider through the bridge', () => {
  const candidates = [
    core(),
    candidate('git', { version: '1.4.0', provides: ['git.commands/v1@1.3.0'] }),
    candidate('panel', { requires: ['git.commands/v1@^1.0.0'] }),
    candidate('strict-panel', { requires: ['git.commands/v1@^1.4.0'] }),
  ];
  const client = resolve(candidates, {}, 'client');

  assert.equal(entry(client, 'panel').state, 'scheduled');
  assert.deepEqual(codes(client, 'strict-panel'), ['incompatible_version']);
});

void test('quarantines a second provider of a one contract without a choice', () => {
  const resolved = resolve([
    core(),
    candidate('otherhooks', { provides: ['hooks/v1@1.0.0'] }),
  ]);

  assert.deepEqual(codes(resolved, 'otherhooks'), ['unchosen_provider']);
  assert.equal(
    entry(resolved, 'otherhooks').reasons[0]?.message,
    'second provider of hooks/v1 without a choice in providers; active: core 1.0.0',
  );
  assert.deepEqual(
    resolved.contracts
      .find(({ id }) => id === 'hooks/v1')
      ?.providers.map(({ bundleId }) => bundleId),
    ['core'],
  );
});

void test('activates the chosen provider of a core contract in the foundation', () => {
  const resolved = resolve(
    [core(), candidate('myhooks', { provides: ['hooks/v1@1.0.0'] })],
    { providers: { 'hooks/v1': 'myhooks' } },
  );

  assert.equal(entry(resolved, 'myhooks').phase, 'foundation');
  assert.deepEqual(resolved.order, ['myhooks', 'core']);
  assert.equal(entry(resolved, 'core').state, 'scheduled');
  assert.deepEqual(
    resolved.contracts
      .find(({ id }) => id === 'hooks/v1')
      ?.providers.map(({ bundleId }) => bundleId),
    ['myhooks'],
  );
});

void test('quarantines providers whose cardinality diverges from the catalog', () => {
  const resolved = resolve([
    core(),
    candidate('openai', {
      provides: ['models.provider/v1@1.0.0'],
      shapes: { 'models.provider/v1': { cardinality: 'many' } },
    }),
    candidate('broken', {
      provides: ['models.provider/v1@1.0.0'],
      shapes: { 'models.provider/v1': { cardinality: 'one' } },
    }),
  ]);

  assert.equal(entry(resolved, 'openai').state, 'scheduled');
  assert.deepEqual(codes(resolved, 'broken'), ['cardinality_mismatch']);
});

void test('lets a foundation facade replacement require the backends, nothing else', () => {
  const postgres = candidate('postgres', {
    provides: ['storage.backend/v1@1.0.0', 'secrets.backend/v1@1.0.0'],
  });
  const coreWithBackends = core({
    provides: [...basics, 'events/v1@1.0.0'],
    requires: ['storage.backend/v1@^1.0.0'],
  });
  const allowed = resolve(
    [
      coreWithBackends,
      postgres,
      candidate('myevents', {
        provides: ['events/v1@1.0.0'],
        requires: ['storage.backend/v1@^1.0.0'],
      }),
    ],
    {
      providers: {
        'storage.backend/v1': 'postgres',
        'secrets.backend/v1': 'postgres',
        'events/v1': 'myevents',
      },
    },
  );

  assert.deepEqual(allowed.order, ['postgres', 'myevents', 'core']);
  assert.equal(allowed.recovery, undefined);

  const refused = resolve(
    [
      coreWithBackends,
      postgres,
      candidate('myevents', {
        provides: ['events/v1@1.0.0'],
        requires: ['tools/v1@^1.0.0'],
      }),
    ],
    {
      providers: {
        'storage.backend/v1': 'postgres',
        'events/v1': 'myevents',
      },
    },
  );

  assert.deepEqual(codes(refused, 'myevents'), ['foundation_requires']);
  assert.match(refused.recovery?.reason ?? '', /myevents/);
});

void test('enters recovery when core is missing, disabled, quarantined or unsatisfied', () => {
  assert.match(
    resolve([candidate('git')], { core: 'core', enabled: ['git'] }).recovery
      ?.reason ?? '',
    /core core unavailable/,
  );
  assert.match(
    resolve([core(), candidate('git')], { enabled: ['git'] }).recovery
      ?.reason ?? '',
    /not enabled/,
  );
  assert.match(
    resolve([core({ engines: '^9.0.0' })]).recovery?.reason ?? '',
    /core core unavailable/,
  );
  assert.match(
    resolve([core({ requires: ['storage.backend/v1@^1.0.0'] })]).recovery
      ?.reason ?? '',
    /storage\.backend\/v1/,
  );
});

void test('takes the cardinality of a contract from the bundle that owns it', () => {
  // `agit` sorts first and declares git.commands/v1 as many; `git` owns it.
  const resolved = resolve([
    core(),
    candidate('agit', {
      provides: ['git.commands/v1@1.0.0'],
      shapes: { 'git.commands/v1': { cardinality: 'many' } },
    }),
    candidate('git', { provides: ['git.commands/v1@1.0.0'] }),
  ]);

  assert.equal(entry(resolved, 'git').state, 'scheduled');
  assert.deepEqual(codes(resolved, 'agit'), ['cardinality_mismatch']);
  assert.deepEqual(
    resolved.contracts.find(({ id }) => id === 'git.commands/v1'),
    {
      id: 'git.commands/v1',
      environment: 'host',
      cardinality: 'one',
      providers: [
        { bundleId: 'git', version: '1.0.0', bundleVersion: '1.0.0' },
      ],
    },
  );
});

void test('a bundle without a readable manifest never collides with a real bundle ID', () => {
  const unreadable: CatalogCandidate = {
    id: 'git',
    source: { kind: 'installed', dir: '/bundles/features/git' },
    errors: [{ code: 'invalid_manifest', message: 'Unexpected end of JSON' }],
  };
  const valid: CatalogCandidate = {
    ...candidate('git'),
    source: { kind: 'installed', dir: '/bundles/zgit' },
  };
  const resolved = resolve([core(), unreadable, valid], {
    enabled: ['core', 'git'],
  });
  const states = resolved.entries
    .filter(({ id }) => id === 'git')
    .map(({ state, reasons }) => [state, reasons.map(({ code }) => code)]);

  assert.deepEqual(states, [
    ['quarantined', ['invalid_manifest']],
    ['scheduled', []],
  ]);
  assert.deepEqual(resolved.order, ['core', 'git']);
});

void test('a quarantined chosen non-foundation provider leaves its contract without a provider', () => {
  const resolved = resolve(
    [
      core(),
      candidate('xa', { provides: ['x.api/v1@1.0.0'] }),
      candidate('xb', { provides: ['x.api/v1@1.0.0'], engines: '^2.0.0' }),
      candidate('user', { requires: ['x.api/v1@^1.0.0'] }),
    ],
    { providers: { 'x.api/v1': 'xb' } },
  );

  assert.equal(resolved.recovery, undefined);
  assert.deepEqual(codes(resolved, 'xb'), ['engines_unsatisfied']);
  assert.deepEqual(codes(resolved, 'xa'), ['unchosen_provider']);
  assert.deepEqual(codes(resolved, 'user'), ['dependency_quarantined']);
  assert.deepEqual(
    resolved.contracts.find(({ id }) => id === 'x.api/v1')?.providers,
    [],
  );
  assert.deepEqual(resolved.order, ['core']);
});

void test('a provider choice applies only where the chosen bundle provides the contract', () => {
  const candidates = [
    core(),
    candidate('xa', { provides: ['x.api/v1@1.0.0'] }),
    candidate('xb', {
      provides: ['x.api/v1@1.0.0'],
      shapes: { 'x.api/v1': { environment: 'client' } },
    }),
  ];
  const composition = { providers: { 'x.api/v1': 'xb' } };
  const activeIn = (environment: 'host' | 'client') =>
    resolve(candidates, composition, environment)
      .contracts.find(({ id }) => id === 'x.api/v1')
      ?.providers.map(({ bundleId }) => bundleId);

  assert.deepEqual(activeIn('host'), ['xa']);
  assert.deepEqual(activeIn('client'), ['xb']);
  assert.equal(
    entry(resolve(candidates, composition), 'xa').state,
    'scheduled',
  );
});
