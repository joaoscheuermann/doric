// Desktop exposure parity (HR-10, BWP-10). What a desktop window may call is
// what the providers of the built composition declare, and each exposed bundle
// contract accepts exactly the window scope keys its provider declares. Both
// equal the frozen snapshot of the allowlist they replace: a change here is a
// change of what the window can reach, and must update the snapshot in review.

import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { readStagedCatalogIndex } from 'bundle/platform';
import { exposureOf, platformContracts } from 'bundle/runtime';

const bundles = 'app/backend/doric-host/dist/bundles';
const composition = 'app/backend/doric-host/composition.json';

interface Snapshot {
  readonly methods: Readonly<Record<string, readonly string[]>>;
  readonly scopeKeys: readonly string[];
  /** Contracts that accept other keys than `scopeKeys`; `[]` is no entry. */
  readonly scopeKeysByContract?: Readonly<Record<string, readonly string[]>>;
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
  readonly id: string;
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
          id,
          contracts: descriptor.contracts as Staged['contracts'],
          desktopScope: manifest.desktopScope as Staged['desktopScope'],
        };
      }),
  );
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * The exposed methods of every host contract the build publishes, by contract.
 * A `service` entry whose document the build did not write (a contract the
 * host part serves without recording it, S62c) counts as exposing nothing:
 * the test below checks that its descriptors expose no `DESKTOP` method.
 */
const exposedMethods = async (
  environment = 'host',
): Promise<Record<string, string[]>> => {
  const exposed: Record<string, string[]> = {};

  for (const bundle of await staged()) {
    for (const contract of bundle.contracts) {
      if (contract.environment !== environment || contract.kind !== 'service') {
        continue;
      }

      const path = join(bundle.dir, contract.schema);

      if (!(await exists(path))) {
        continue;
      }

      const document = await readJson(path);
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
    'chat.composer/v1': [
      'addItem',
      'flush',
      'read',
      'removeItem',
      'setText',
      'updateNote',
      'watch',
    ],
    'core.commands/v1': ['execute'],
    'history.snapshots/v1': ['read', 'write'],
    'menus/v1': ['addItem', 'addKeybinding', 'setContext'],
    'notifications.observations/v1': ['report'],
    'papercraft.cache/v1': ['ensure'],
    'papercraft.snapshot/v1': ['capture'],
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

void test('a host entry without a staged document is a contract whose descriptors expose no DESKTOP method', async () => {
  const undocumented: { readonly bundle: string; readonly id: string }[] = [];

  for (const bundle of await staged()) {
    for (const contract of bundle.contracts) {
      if (
        contract.environment === 'host' &&
        contract.kind === 'service' &&
        !(await exists(join(bundle.dir, contract.schema)))
      ) {
        undocumented.push({ bundle: bundle.id, id: contract.id });
      }
    }
  }

  // The contracts host parts serve without recording them (S62c): transport's
  // public API and runtime's executor.session/v1.
  assert.deepEqual(undocumented.map(({ id }) => id).sort(), [
    'api.config/v1',
    'api.credentials/v1',
    'api.host/v1',
    'api.projects/v1',
    'api.providers/v1',
    'api.status/v1',
    'api.terminals/v1',
    'api.threads/v1',
    'executor.session/v1',
  ]);

  const index = await readStagedCatalogIndex(
    bundles,
    undocumented.map(({ bundle }) => bundle),
  );
  const ids = new Set(undocumented.map(({ id }) => id));

  for (const id of ids) {
    assert.ok(index.contract(id), `${id} is in the staged descriptors`);
  }
  assert.deepEqual(
    index
      .desktopMethods()
      .filter(({ contract }) => ids.has(contract.id))
      .map(({ method }) => method.name),
    [],
  );
});

void test('every exposed bundle contract accepts exactly the frozen window scope keys', async () => {
  const snapshot = await loadSnapshot();
  const accepted = await scopeKeysOf();

  for (const contract of Object.keys(snapshot.methods)) {
    if (contract.startsWith('doric.')) {
      continue;
    }

    const expected = snapshot.scopeKeysByContract?.[contract];

    assert.deepEqual(
      expected === undefined ? accepted[contract] : (accepted[contract] ?? []),
      [...(expected ?? snapshot.scopeKeys)].sort(),
      contract,
    );
  }
});
