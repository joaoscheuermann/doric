// The publish of a host, without processes (spec
// `docs/designs/grpc-processes.md`, section 6, "Generations and drain",
// "Publish"; T2.6, AC2.6): what a publish compares of a bundle
// (`signatureOf`), which bundles it handles and in which order
// (`changedBundles`), and what it asks of the supervisor (`publish` on a fake
// `PublishTarget`): `kernel_restart_required` when `core` changed, otherwise
// `adopt`, then `replace` or `retire` per changed bundle in activation order.
// Also the rule of `InstanceTable.activeOf` during a publish: the highest
// generation, then the highest incarnation.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  InstanceTable,
  instanceKey,
} from '../../src/platform/router/instances.js';
import {
  type BundleGeneration,
  changedBundles,
  kernelBundleId,
  kernelRestartReason,
  type PublishTarget,
  publish,
  signatureOf,
} from '../../src/platform/supervisor/publish.js';
import type { ResolvedEnvironment } from '../../src/runtime/index.js';
import { type FixtureBundle, resolveHost } from '../support/scripted-host.js';

// ---------------------------------------------------------------------------
// Helpers

const settingsProvider: FixtureBundle = {
  mode: 'alive',
  provides: ['settings/v1@1.0.0'],
};
const settingsUser: FixtureBundle = {
  mode: 'alive',
  requires: ['settings/v1@^1.0.0'],
};

/**
 * `core`, `settings` (provides `settings/v1`), `app` (requires it) and
 * `zed`: the activation order is `core`, `settings`, `app`, `zed` while the
 * entries list `app` before `settings`.
 */
const base = (
  overrides: Readonly<Record<string, FixtureBundle>> = {},
  options: { readonly disabled?: readonly string[] } = {},
): ResolvedEnvironment =>
  resolveHost(
    {
      app: settingsUser,
      settings: settingsProvider,
      zed: { mode: 'alive' },
      ...overrides,
    },
    options,
  );

const digests =
  (map: Readonly<Record<string, string>> = {}) =>
  (bundleId: string): string =>
    map[bundleId] ?? '';

/** The running generations of every scheduled bundle of `resolved`. */
const runningOf =
  (
    resolved: ResolvedEnvironment,
    digestOf: (bundleId: string) => string = digests(),
    generation = 1,
  ) =>
  (bundleId: string): BundleGeneration | undefined => {
    if (!resolved.order.includes(bundleId)) {
      return undefined;
    }

    const signature = signatureOf(resolved, bundleId, digestOf(bundleId));

    return signature === undefined
      ? undefined
      : { bundleId, generation, signature };
  };

interface FakeTarget extends PublishTarget {
  /** `adopt`, `replace:<id>:<digest>` and `retire:<id>`, in call order. */
  readonly calls: string[];
  readonly adopted: ResolvedEnvironment[];
}

const fakeTarget = (
  running: (bundleId: string) => BundleGeneration | undefined,
  answers: Readonly<Record<string, 'active' | 'failed'>> = {},
): FakeTarget => {
  const calls: string[] = [];
  const adopted: ResolvedEnvironment[] = [];

  return {
    calls,
    adopted,
    generationOf: running,
    adopt: (next) => {
      adopted.push(next);
      calls.push('adopt');
    },
    replace: (bundleId, digest) => {
      calls.push(`replace:${bundleId}:${digest}`);

      return Promise.resolve(answers[bundleId] ?? 'active');
    },
    retire: (bundleId) => {
      calls.push(`retire:${bundleId}`);

      return Promise.resolve();
    },
  };
};

// ---------------------------------------------------------------------------
// signatureOf

describe('signatureOf', () => {
  test('is equal for the same resolution and digest, whatever the order of entries and contracts', () => {
    const resolved = base();
    const shuffled: ResolvedEnvironment = {
      ...resolved,
      entries: [...resolved.entries].reverse(),
      contracts: [...resolved.contracts].reverse(),
    };

    for (const id of ['core', 'settings', 'app', 'zed']) {
      const signature = signatureOf(resolved, id, 'abc');

      assert.equal(typeof signature, 'string', id);
      assert.equal(signatureOf(base(), id, 'abc'), signature, id);
      assert.equal(signatureOf(shuffled, id, 'abc'), signature, id);
    }
  });

  test('differs when the executable digest differs', () => {
    const resolved = base();

    assert.notEqual(
      signatureOf(resolved, 'settings', 'abc'),
      signatureOf(resolved, 'settings', 'def'),
    );
  });

  test('differs when the version differs', () => {
    assert.notEqual(
      signatureOf(base(), 'zed', ''),
      signatureOf(
        base({ zed: { mode: 'alive', version: '1.1.0' } }),
        'zed',
        '',
      ),
    );
  });

  test('differs when the contracts the bundle provides differ', () => {
    assert.notEqual(
      signatureOf(base(), 'settings', ''),
      signatureOf(
        base({ settings: { mode: 'alive', provides: ['settings/v1@1.1.0'] } }),
        'settings',
        '',
      ),
    );
  });

  test('differs when the state differs', () => {
    assert.notEqual(
      signatureOf(base(), 'zed', ''),
      signatureOf(base({}, { disabled: ['zed'] }), 'zed', ''),
    );
  });

  test('does not change when another bundle changes', () => {
    assert.equal(
      signatureOf(base(), 'settings', ''),
      signatureOf(
        base({ zed: { mode: 'alive', version: '2.0.0' } }),
        'settings',
        '',
      ),
    );
  });

  test('is undefined for a bundle the resolution has no entry for', () => {
    assert.equal(signatureOf(base(), 'nobody', ''), undefined);
  });
});

// ---------------------------------------------------------------------------
// changedBundles

describe('changedBundles', () => {
  test('lists nothing when no bundle changed', () => {
    const resolved = base();

    assert.deepEqual(
      changedBundles(runningOf(resolved), base(), digests()),
      [],
    );
  });

  test('lists a bundle whose executable digest changed, and only it', () => {
    const resolved = base();

    assert.deepEqual(
      changedBundles(runningOf(resolved), base(), digests({ zed: 'new' })),
      ['zed'],
    );
  });

  test('lists the changed bundles in activation order, not in entry order', () => {
    const resolved = base();

    assert.deepEqual(
      changedBundles(
        runningOf(resolved),
        base(),
        digests({ app: 'new', zed: 'new', settings: 'new' }),
      ),
      ['settings', 'app', 'zed'],
    );
  });

  test('lists a bundle whose version changed', () => {
    const resolved = base();

    assert.deepEqual(
      changedBundles(
        runningOf(resolved),
        base({ app: { ...settingsUser, version: '1.0.1' } }),
        digests(),
      ),
      ['app'],
    );
  });

  test('lists a scheduled bundle that has no running generation', () => {
    const before = resolveHost({ settings: settingsProvider });
    const next = base();

    assert.deepEqual(changedBundles(runningOf(before), next, digests()), [
      'app',
      'zed',
    ]);
  });

  test('does not list a bundle without a running generation that next does not schedule', () => {
    const before = resolveHost({
      app: settingsUser,
      settings: settingsProvider,
    });
    const next = base({}, { disabled: ['zed'] });

    assert.deepEqual(changedBundles(runningOf(before), next, digests()), []);
  });

  test('lists a running bundle that next disables (section 6, "Publish", step 4)', () => {
    const resolved = base();

    assert.ok(
      changedBundles(
        runningOf(resolved),
        base({}, { disabled: ['zed'] }),
        digests(),
      ).includes('zed'),
    );
  });

  test('reads digestOf once per bundle of the activation order', () => {
    const resolved = base();
    const reads: string[] = [];

    changedBundles(runningOf(resolved), base(), (bundleId) => {
      reads.push(bundleId);

      return '';
    });

    assert.deepEqual([...reads].sort(), ['app', 'core', 'settings', 'zed']);
  });

  test('propagates a throw of digestOf', () => {
    const resolved = base();

    assert.throws(
      () =>
        changedBundles(runningOf(resolved), base(), () => {
          throw new Error('unreadable executable');
        }),
      /unreadable executable/,
    );
  });
});

// ---------------------------------------------------------------------------
// publish

describe('publish', () => {
  test('answers kernel_restart_required and changes nothing when the core changed', async () => {
    const resolved = base();
    const target = fakeTarget(runningOf(resolved));

    const result = await publish(
      target,
      base(),
      digests({ [kernelBundleId]: 'new', zed: 'new' }),
    );

    assert.deepEqual(result, {
      status: 'kernel_restart_required',
      reason: kernelRestartReason,
    });
    assert.equal(kernelRestartReason, 'The core changed; restart the host.');
    assert.deepEqual(target.calls, []);
  });

  test('answers published with no bundle, after adopting next, when nothing changed', async () => {
    const resolved = base();
    const next = base();
    const target = fakeTarget(runningOf(resolved));

    const result = await publish(target, next, digests());

    assert.deepEqual(result, { status: 'published', bundles: [] });
    assert.deepEqual(target.calls, ['adopt']);
    assert.equal(target.adopted[0], next);
  });

  test('adopts next first, then replaces each changed bundle in activation order with its digest', async () => {
    const resolved = base();
    const target = fakeTarget(runningOf(resolved));

    const result = await publish(
      target,
      base(),
      digests({ zed: 'z2', settings: 's2' }),
    );

    assert.deepEqual(result, {
      status: 'published',
      bundles: ['settings', 'zed'],
    });
    assert.deepEqual(target.calls, [
      'adopt',
      'replace:settings:s2',
      'replace:zed:z2',
    ]);
  });

  test('handles the changed bundles one after the other', async () => {
    const resolved = base();
    const calls: string[] = [];
    let finishFirst: (answer: 'active') => void = () => {};
    const target: PublishTarget = {
      generationOf: runningOf(resolved),
      adopt: () => {},
      replace: (bundleId) => {
        calls.push(bundleId);

        return calls.length === 1
          ? new Promise((resolve) => {
              finishFirst = resolve;
            })
          : Promise.resolve('active');
      },
      retire: () => Promise.resolve(),
    };

    const publishing = publish(
      target,
      base(),
      digests({ settings: 'new', zed: 'new' }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, ['settings']);

    finishFirst('active');

    assert.deepEqual(await publishing, {
      status: 'published',
      bundles: ['settings', 'zed'],
    });
    assert.deepEqual(calls, ['settings', 'zed']);
  });

  test('retires, without replacing, a running bundle that next disables', async () => {
    const resolved = base();
    const target = fakeTarget(runningOf(resolved));

    const result = await publish(
      target,
      base({}, { disabled: ['zed'] }),
      digests(),
    );

    assert.deepEqual(result, { status: 'published', bundles: ['zed'] });
    assert.deepEqual(target.calls, ['adopt', 'retire:zed']);
  });

  test('starts a scheduled bundle that has no running generation through replace', async () => {
    const before = resolveHost({
      app: settingsUser,
      settings: settingsProvider,
    });
    const target = fakeTarget(runningOf(before));

    const result = await publish(target, base(), digests({ zed: 'z1' }));

    assert.deepEqual(result, { status: 'published', bundles: ['zed'] });
    assert.deepEqual(target.calls, ['adopt', 'replace:zed:z1']);
  });

  test('answers failed with the bundles whose replace failed, after handling every other one', async () => {
    const resolved = base();
    const target = fakeTarget(runningOf(resolved), { settings: 'failed' });

    const result = await publish(
      target,
      base(),
      digests({ settings: 's2', app: 'a2', zed: 'z2' }),
    );

    assert.equal(result.status, 'failed');
    assert.ok(result.status === 'failed');
    assert.deepEqual(result.bundles, ['settings']);
    assert.match(result.reason, /settings/);
    assert.deepEqual(target.calls, [
      'adopt',
      'replace:settings:s2',
      'replace:app:a2',
      'replace:zed:z2',
    ]);
  });

  test('rejects before anything changed when digestOf throws', async () => {
    const resolved = base();
    const target = fakeTarget(runningOf(resolved));

    await assert.rejects(
      publish(target, base(), () => {
        throw new Error('unreadable executable');
      }),
      /unreadable executable/,
    );
    assert.deepEqual(target.calls, []);
  });
});

// ---------------------------------------------------------------------------
// activeOf

describe('InstanceTable.activeOf during a publish', () => {
  const issueActive = (
    table: InstanceTable,
    generation: number,
    incarnation: number,
  ): void => {
    const instance = {
      bundleId: 'b',
      version: '1.0.0',
      generation,
      incarnation,
    };

    table.issue(instance);
    table.setState(instanceKey(instance), 'active');
  };

  test('answers the active instance of the highest generation', () => {
    const table = new InstanceTable();

    issueActive(table, 1, 1);
    issueActive(table, 2, 1);

    assert.equal(table.activeOf('b')?.generation, 2);
  });

  test('answers the highest incarnation within the highest generation', () => {
    const table = new InstanceTable();

    issueActive(table, 2, 1);
    issueActive(table, 1, 3);
    issueActive(table, 2, 2);

    const active = table.activeOf('b');

    assert.deepEqual(
      active && {
        generation: active.generation,
        incarnation: active.incarnation,
      },
      { generation: 2, incarnation: 2 },
    );
  });

  test('never answers a draining instance', () => {
    const table = new InstanceTable();

    issueActive(table, 1, 1);
    issueActive(table, 2, 1);
    table.setState('b/2/1', 'draining');

    assert.equal(table.activeOf('b')?.generation, 1);

    table.setState('b/1/1', 'draining');

    assert.equal(table.activeOf('b'), undefined);
  });
});
