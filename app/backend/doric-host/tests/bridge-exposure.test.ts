// Desktop exposure parity (HR-10, BWP-10). What a desktop window may call is
// what the providers of the built composition declare, and each exposed bundle
// contract accepts exactly the window scope keys its provider declares. Both
// equal the frozen snapshot of the allowlist they replace: a change here is a
// change of what the window can reach, and must update the snapshot in review.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { exposureOf, platformContracts } from 'bundle/runtime';

const bundles = 'app/backend/doric-host/dist/bundles';
const composition = 'app/backend/doric-host/composition.json';

interface Snapshot {
  readonly methods: Readonly<Record<string, readonly string[]>>;
  readonly scopeKeys: readonly string[];
}

const loadSnapshot = async (): Promise<Snapshot> =>
  JSON.parse(
    await readFile(
      'app/backend/doric-host/tests/bridge-exposure.snapshot.json',
      'utf8',
    ),
  ) as Snapshot;

interface Staged {
  readonly contracts: readonly {
    readonly id: string;
    readonly environment: string;
    readonly kind: string;
    readonly schema: string;
  }[];
  readonly desktopScope?: Readonly<Record<string, readonly string[]>>;
  readonly dir: string;
}

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

/** The bundles the composition enables, staged by the build: descriptor and manifest of each. */
const staged = async (): Promise<Staged[]> => {
  const enabled = new Set(
    (await readJson(composition)).enabled as readonly string[],
  );

  return Promise.all(
    (await readdir(bundles))
      .filter((id) => enabled.has(id))
      .map(async (id) => {
        const dir = join(bundles, id);
        const descriptor = await readJson(join(dir, 'contracts.json'));
        const manifest = await readJson(join(dir, 'manifest.json'));

        return {
          dir,
          contracts: descriptor.contracts as Staged['contracts'],
          desktopScope: manifest.desktopScope as Staged['desktopScope'],
        };
      }),
  );
};

/** The exposed methods of every host contract the build publishes, by contract. */
const exposedMethods = async (
  environment = 'host',
): Promise<Record<string, string[]>> => {
  const exposed: Record<string, string[]> = {};

  for (const bundle of await staged()) {
    for (const contract of bundle.contracts) {
      if (contract.environment !== environment || contract.kind !== 'service') {
        continue;
      }

      const document = await readJson(join(bundle.dir, contract.schema));
      const methods = Object.entries(
        (document['x-doric-expose'] ?? {}) as Record<string, string>,
      )
        .filter(([, target]) => target === 'desktop')
        .map(([method]) => method);

      if (methods.length > 0) {
        exposed[contract.id] = methods.sort();
      }
    }
  }

  // The platform's own contracts publish their exposure in packages/bundle.
  for (const [id, spec] of Object.entries(
    environment === 'host' ? platformContracts : {},
  )) {
    const methods = Object.keys(spec.methods).filter(
      (method) => exposureOf(id, method) === 'desktop',
    );

    if (methods.length > 0) {
      exposed[id] = methods.sort();
    }
  }

  return Object.fromEntries(
    Object.entries(exposed).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
};

/** The window scope keys each exposed bundle contract accepts, by contract. */
const scopeKeysOf = async (): Promise<Record<string, string[]>> => {
  const accepted: Record<string, string[]> = {};

  for (const bundle of await staged()) {
    for (const [id, keys] of Object.entries(bundle.desktopScope ?? {})) {
      accepted[id] = [...keys].sort();
    }
  }

  return accepted;
};

void test('the exposed methods of the built composition equal the frozen allowlist', async () => {
  assert.deepEqual(await exposedMethods(), (await loadSnapshot()).methods);
});

void test('desktop providers expose exactly the operations used by clients', async () => {
  assert.deepEqual(await exposedMethods('desktopMain'), {
    'core.commands/v1': ['execute'],
    'history.snapshots/v1': ['read', 'write'],
    'menus/v1': ['addItem', 'addKeybinding', 'setContext'],
    'notifications.observations/v1': ['report'],
    'screen.views/v1': [
      'add',
      'deliver',
      'list',
      'open',
      'remove',
      'retry',
      'watch',
    ],
    'windows/v1': ['open'],
  });
});

void test('every exposed bundle contract accepts exactly the frozen window scope keys', async () => {
  const snapshot = await loadSnapshot();
  const accepted = await scopeKeysOf();

  for (const contract of Object.keys(snapshot.methods)) {
    if (contract.startsWith('doric.')) {
      continue;
    }

    assert.deepEqual(
      accepted[contract],
      [...snapshot.scopeKeys].sort(),
      contract,
    );
  }
});
