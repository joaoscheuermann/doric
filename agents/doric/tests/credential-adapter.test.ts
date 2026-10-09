import assert from 'node:assert/strict';
import test from 'node:test';

import { SecretsBackendV1, type StoredSecret } from 'bundle/contracts';
import { memoryFoundation } from 'storage/memory';

import { publicCredential } from '../src/lib/credentials/kind.js';
import {
  type CredentialService,
  MissingKeyError,
} from '../src/lib/credentials/service.js';
import { persistenceFixture } from './helpers/persistence-fixture.js';
import { type Kernel, kernelOver, startKernel } from './helpers/platform.js';

// The CredentialService contract the routes, the workspace service, models and
// generation rely on, now answered by `secrets/v1` through the kernel adapter.

const connectionString = process.env.DORIC_TEST_DATABASE_URL;

const kernel = (
  options: {
    readonly keyConfigured?: boolean;
    readonly rows?: readonly StoredSecret[];
  } = {},
): Promise<Kernel> =>
  startKernel({ foundation: memoryFoundation({ secrets: options }) });

const withService = async (
  run: (service: CredentialService, kernel: Kernel) => Promise<void>,
  options?: Parameters<typeof kernel>[0],
) => {
  const booted = await kernel(options);
  try {
    await run(booted.credentials, booted);
  } finally {
    await booted.close();
  }
};

const stored = (rows: Kernel) =>
  rows.platform.services.use(SecretsBackendV1).list();

void test('answers a stored secret only to the host, never in the public view', () =>
  withService(async (service) => {
    const created = await service.create({
      kind: 'API_TOKEN',
      name: 'openrouter',
      secret: 'sk_secret',
    });

    assert.equal(created.status, 'saved');
    if (created.status !== 'saved') return;
    assert.equal(created.credential.secret, 'sk_secret');
    assert.deepEqual(service.secrets(), ['sk_secret']);
    assert.equal(service.byId(created.credential.id).secret, 'sk_secret');

    const view = publicCredential(service.list()[0]);
    assert.deepEqual(view, {
      id: created.credential.id,
      kind: 'API_TOKEN',
      name: 'openrouter',
      hasSecret: true,
    });
    assert.equal(JSON.stringify(view).includes('sk_secret'), false);
  }));

void test('refuses to start when a stored secret has no key, but not for an empty one', async () => {
  await assert.rejects(
    kernel({
      keyConfigured: false,
      rows: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          kind: 'API_TOKEN',
          name: 'openrouter',
          secret: 'sk_at_rest',
        },
      ],
    }),
    { code: 'credential_key_required' },
  );

  await withService(
    async (service) => {
      assert.equal(service.list()[0]?.secret, '');
      assert.deepEqual(service.secrets(), []);
    },
    {
      keyConfigured: false,
      rows: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          kind: 'API_TOKEN',
          name: 'openrouter',
          secret: '',
        },
      ],
    },
  );
});

void test('redacts a secret it learned after the store was read', () =>
  withService(async (service) => {
    const learned = 'ghp_learned_in_a_sandbox';

    assert.deepEqual(service.secrets(), []);
    service.register(learned);
    // An empty secret is no secret, exactly as the store's own rule reads it.
    service.register('');
    assert.deepEqual(service.secrets(), [learned]);
  }));

void test('keeps, clears, and sets a stored field through one rule', () =>
  withService(async (service) => {
    const created = await service.create({
      kind: 'GIT',
      name: 'github',
      username: 'octocat',
      email: 'octocat@example.com',
    });
    if (created.status !== 'saved') throw new Error('expected a saved row');
    const { id } = created.credential;

    // An absent or null field keeps the stored value; a value sets it.
    assert.equal(
      (await service.update(id, { name: 'renamed' })).status,
      'saved',
    );
    assert.deepEqual(service.byId(id), {
      id,
      kind: 'GIT',
      name: 'renamed',
      username: 'octocat',
      email: 'octocat@example.com',
    });
    assert.equal(
      (await service.update(id, { username: null })).status,
      'saved',
    );
    assert.equal(service.byId(id).username, 'octocat');

    const cleared = await service.update(id, { email: '' });
    assert.equal(cleared.status, 'saved');
    assert.equal(service.byId(id).email, '');

    // A field the kind forbids is rejected, and so is a changed kind.
    const forbidden = await service.update(id, { secret: 'x' });
    assert.equal(forbidden.status, 'invalid');
    if (forbidden.status === 'invalid')
      assert.equal(
        forbidden.message,
        'A GIT credential requires username, email and carries no other field.',
      );
    assert.equal(
      (await service.update(id, { kind: 'API_TOKEN' })).status,
      'immutable',
    );
    assert.equal(
      (await service.update('missing', { name: 'x' })).status,
      'missing',
    );
  }));

void test('a name a kind already uses is a conflict, not a second credential', () =>
  withService(async (service, booted) => {
    await service.create({ kind: 'API_TOKEN', name: 'key', secret: 'a' });

    assert.deepEqual(
      await service.create({ kind: 'API_TOKEN', name: 'key', secret: 'b' }),
      { status: 'conflict' },
    );
    // Another kind may use the same name.
    assert.equal(
      (
        await service.create({
          kind: 'GIT',
          name: 'key',
          username: 'octocat',
          email: 'octocat@example.com',
        })
      ).status,
      'saved',
    );
    assert.equal((await stored(booted)).length, 2);
  }));

void test('keeps a provider key out of an unclaimed-kind fallback', () =>
  withService(async (service) => {
    const providerKey = await service.create({
      kind: 'API_TOKEN',
      name: 'openrouter',
      secret: 'sk_provider',
    });
    if (providerKey.status !== 'saved') throw new Error('expected a saved row');

    // The only API_TOKEN is the provider's key, so an integration that merely
    // asks for that kind by fallback finds nothing.
    assert.equal(service.byKind('API_TOKEN')?.secret, 'sk_provider');
    assert.equal(
      service.byUnclaimedKind(
        'API_TOKEN',
        new Set([providerKey.credential.id]),
      ),
      undefined,
    );

    await service.create({
      kind: 'API_TOKEN',
      name: 'github',
      secret: 'ghp_token',
    });

    assert.equal(
      service.byUnclaimedKind('API_TOKEN', new Set([providerKey.credential.id]))
        ?.secret,
      'ghp_token',
    );
    // Two of one kind is a refusal to guess, not a pick.
    assert.throws(
      () => service.byKind('API_TOKEN'),
      /More than one API_TOKEN credential is stored; name the one to use\./u,
    );
  }));

void test('stops resolving a credential once it is deleted', () =>
  withService(async (service) => {
    const created = await service.create({
      kind: 'API_TOKEN',
      name: 'openrouter',
      secret: 'sk_secret',
    });
    if (created.status !== 'saved') throw new Error('expected a saved row');
    const { id } = created.credential;

    assert.equal(await service.remove(id), 'deleted');
    assert.equal(service.find(id), undefined);
    assert.equal(service.byKind('API_TOKEN'), undefined);
    assert.deepEqual(service.secrets(), []);
    assert.equal(await service.remove(id), 'missing');
  }));

void test('applies the field rule to a create the route did not check', () =>
  withService(async (service, booted) => {
    const rejected = await service.create({
      kind: 'GIT',
      name: 'github',
      username: 'octocat',
      email: 'octocat@example.com',
      secret: 'x',
    });

    assert.deepEqual(rejected, {
      status: 'invalid',
      message:
        'A GIT credential requires username, email and carries no other field.',
    });
    assert.deepEqual(await stored(booted), []);
    assert.equal(
      (
        await service.create({
          kind: 'GIT',
          name: 'github',
          username: 'octocat',
          email: 'octocat@example.com',
        })
      ).status,
      'saved',
    );
  }));

void test('refuses to write a secret without a key, and still stores a kind without one', () =>
  withService(
    async (service, booted) => {
      await assert.rejects(
        service.create({ kind: 'API_TOKEN', name: 'key', secret: 'x' }),
        MissingKeyError,
      );
      // Even the empty secret a migration left is a secret write.
      await assert.rejects(
        service.update('00000000-0000-4000-8000-000000000001', { secret: '' }),
        MissingKeyError,
      );
      assert.deepEqual(
        (await stored(booted)).map(({ name }) => name),
        ['openrouter'],
      );

      const identity = await service.create({
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
      });
      assert.equal(identity.status, 'saved');
    },
    {
      keyConfigured: false,
      rows: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          kind: 'API_TOKEN',
          name: 'openrouter',
          secret: '',
        },
      ],
    },
  ));

void test('lists credentials in store order at start, then by name after each save, keeping the order on delete', () =>
  withService(
    async (service) => {
      // `C` order of the store puts the capital first; localeCompare does not.
      assert.deepEqual(
        service.list().map(({ name }) => name),
        ['Zed', 'alpha', 'beta'],
      );

      const deleted = await service.remove(
        '00000000-0000-4000-8000-000000000003',
      );
      assert.equal(deleted, 'deleted');
      assert.deepEqual(
        service.list().map(({ name }) => name),
        ['Zed', 'beta'],
      );

      await service.create({ kind: 'API_TOKEN', name: 'gamma', secret: 'g' });
      assert.deepEqual(
        service.list().map(({ name }) => name),
        ['beta', 'gamma', 'Zed'],
      );
    },
    {
      rows: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          kind: 'API_TOKEN',
          name: 'beta',
          secret: 'b',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          kind: 'API_TOKEN',
          name: 'Zed',
          secret: 'z',
        },
        {
          id: '00000000-0000-4000-8000-000000000003',
          kind: 'API_TOKEN',
          name: 'alpha',
          secret: 'a',
        },
      ],
    },
  ));

// The cipher boundary, which moved into the `postgres` backend, read through
// the same service over a real database.

const databaseTest = (
  name: string,
  run: (
    resources: Awaited<ReturnType<typeof persistenceFixture>>,
  ) => Promise<void>,
) =>
  void test(name, { skip: connectionString === undefined }, async () => {
    assert.ok(connectionString);
    const resources = await persistenceFixture(connectionString);
    try {
      await run(resources);
    } finally {
      await resources.close();
    }
  });

databaseTest(
  'seals each secret in a fresh versioned envelope that only its key opens',
  async ({ database }) => {
    const booted = await kernelOver(database);
    try {
      const first = await booted.credentials.create({
        kind: 'API_TOKEN',
        name: 'first',
        secret: 'super-secret',
      });
      const second = await booted.credentials.create({
        kind: 'API_TOKEN',
        name: 'second',
        secret: 'super-secret',
      });
      assert.equal(first.status, 'saved');
      assert.equal(second.status, 'saved');
    } finally {
      await booted.close();
    }

    const rows = await database.credential.findMany({
      where: { name: { in: ['first', 'second'] } },
      orderBy: { name: 'asc' },
    });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row.secret ?? '', /^v1:/u);
      assert.equal(row.secret?.includes('super-secret'), false);
    }
    assert.notEqual(rows[0]?.secret, rows[1]?.secret);

    const reopened = await kernelOver(database);
    try {
      assert.deepEqual(
        reopened.credentials
          .list()
          .filter(({ name }) => name === 'first' || name === 'second')
          .map(({ secret }) => secret),
        ['super-secret', 'super-secret'],
      );
    } finally {
      await reopened.close();
    }

    await assert.rejects(
      kernelOver(database, {
        DORIC_CREDENTIAL_KEY: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      }),
      { code: 'credential_unreadable' },
    );
  },
);

databaseTest(
  'treats a blank key as no key and refuses an unusable one at start',
  async ({ database }) => {
    const blank = await kernelOver(database, { DORIC_CREDENTIAL_KEY: '  ' });
    try {
      // The seeded provider credential holds an empty secret, so it starts.
      assert.deepEqual(blank.credentials.secrets(), []);
      await assert.rejects(
        blank.credentials.create({
          kind: 'API_TOKEN',
          name: 'key',
          secret: 'x',
        }),
        MissingKeyError,
      );
    } finally {
      await blank.close();
    }

    for (const key of ['short', '!'.repeat(44)])
      await assert.rejects(
        kernelOver(database, { DORIC_CREDENTIAL_KEY: key }),
        /DORIC_CREDENTIAL_KEY must be 32 base64-encoded bytes\./u,
      );
  },
);
