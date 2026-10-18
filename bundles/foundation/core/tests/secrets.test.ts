import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type CredentialKindDefinition,
  isContractError,
  type Secrets,
  SecretsBackendV1,
  SecretsV1,
  type StoredSecret,
} from 'bundle/contracts';
import type { MemorySecretsOptions } from 'storage/memory';

import { boot, core } from './support/host.js';

// D-S: the secrets/v1 facade over secrets.backend/v1 (stage 2+3 design §5.4),
// with the cases of the host's credential service tests.

/** The GIT kind as the git bundle registers it when it activates. */
const gitKind: CredentialKindDefinition = {
  id: 'GIT',
  required: ['username', 'email'],
  optional: [],
};

const withSecrets = async (
  run: (
    secrets: Secrets,
    host: Awaited<ReturnType<typeof boot>>,
  ) => Promise<void>,
  memory: MemorySecretsOptions = {},
) => {
  const host = await boot([await core()], { memory: { secrets: memory } });

  try {
    const secrets = host.platform.services.use(SecretsV1);

    secrets.registerKind(gitKind);
    await run(secrets, host);
  } finally {
    await host.close();
  }
};

const row = (
  id: string,
  name: string,
  fields: Partial<StoredSecret> = {},
): StoredSecret => ({ id, kind: 'API_TOKEN', name, secret: '', ...fields });

void test('a stored secret resolves for the host while its description only says it exists', async () => {
  await withSecrets(async (secrets, host) => {
    const created = await secrets.create({
      kind: 'API_TOKEN',
      name: 'openrouter',
      secret: 'sk_secret',
    });

    assert.deepEqual(created, {
      id: created.id,
      kind: 'API_TOKEN',
      name: 'openrouter',
      hasSecret: true,
    });
    assert.equal(JSON.stringify(created).includes('sk_secret'), false);
    assert.equal(
      (await secrets.resolve({ id: created.id })).secret,
      'sk_secret',
    );
    assert.deepEqual(await secrets.describe({ id: created.id }), created);
    assert.deepEqual(await secrets.list(), [created]);
    assert.deepEqual(await secrets.redactions(), ['sk_secret']);

    // The backend stored the row the facade wrote.
    const stored = await host.platform.services
      .use(SecretsBackendV1)
      .get(created.id);

    assert.equal(stored?.secret, 'sk_secret');
  });
});

void test('an unknown reference is credential_missing and a description of it is absent', async () => {
  await withSecrets(async (secrets) => {
    await assert.rejects(secrets.resolve({ id: 'nope' }), {
      code: 'credential_missing',
      message: 'Credential nope is not stored.',
    });
    assert.equal(await secrets.describe({ id: 'nope' }), undefined);
  });
});

void test('the list keeps the backend order at load, sorts by name after a save, and keeps it after a removal', async () => {
  await withSecrets(
    async (secrets) => {
      const names = async () => (await secrets.list()).map(({ name }) => name);

      assert.deepEqual(await names(), ['B', 'a', 'b']);

      await secrets.delete({ id: '2' });
      assert.deepEqual(await names(), ['B', 'b']);

      await secrets.create({ kind: 'API_TOKEN', name: 'c', secret: 'x' });
      assert.deepEqual(await names(), ['b', 'B', 'c']);
    },
    { rows: [row('1', 'b'), row('2', 'a'), row('3', 'B')] },
  );
});

void test('a stored secret without a key refuses the load; an empty secret does not', async () => {
  await withSecrets(
    async (secrets) => {
      await assert.rejects(secrets.list(), {
        code: 'credential_key_required',
        message:
          'DORIC_CREDENTIAL_KEY is required while a stored credential holds a secret.',
      });
    },
    {
      keyConfigured: false,
      rows: [row('1', 'openrouter', { secret: 'v1:AAAA:BBBB:CCCC' })],
    },
  );

  await withSecrets(
    async (secrets) => {
      assert.equal((await secrets.resolve({ id: '1' })).secret, '');
      assert.deepEqual(await secrets.redactions(), []);
    },
    { keyConfigured: false, rows: [row('1', 'openrouter')] },
  );
});

void test('the in-process view exists once credentials are loaded and redacts what the host adds', async () => {
  await withSecrets(
    async (secrets) => {
      assert.throws(() => secrets.view(), { code: 'unavailable' });

      await secrets.list();

      const view = secrets.view();

      assert.deepEqual(view.redactions(), ['sk_stored']);

      view.addRedaction('ghp_learned_in_a_sandbox');
      // An empty secret is no secret.
      view.addRedaction('');

      assert.deepEqual(view.redactions(), [
        'sk_stored',
        'ghp_learned_in_a_sandbox',
      ]);
      assert.deepEqual(await secrets.redactions(), view.redactions());

      // The view follows later writes.
      await secrets.create({ kind: 'API_TOKEN', name: 'a', secret: 'sk_new' });
      assert.deepEqual(view.redactions(), [
        'sk_new',
        'sk_stored',
        'ghp_learned_in_a_sandbox',
      ]);
      assert.deepEqual(
        view.list().map(({ name }) => name),
        ['a', 'openrouter'],
      );
    },
    { rows: [row('1', 'openrouter', { secret: 'sk_stored' })] },
  );
});

void test('an update keeps an absent or null field, sets any string, and keeps the kind', async () => {
  await withSecrets(async (secrets) => {
    const { id } = await secrets.create({
      kind: 'GIT',
      name: 'github',
      username: 'octocat',
      email: 'octocat@example.com',
    });

    const kept = await secrets.update({ id }, { name: 'renamed', email: null });

    assert.deepEqual(kept, {
      id,
      kind: 'GIT',
      name: 'renamed',
      username: 'octocat',
      email: 'octocat@example.com',
      hasSecret: false,
    });

    await secrets.update({ id }, { email: '' });
    assert.deepEqual(await secrets.resolve({ id }), {
      id,
      kind: 'GIT',
      name: 'renamed',
      username: 'octocat',
      email: '',
    });
    // An empty email is not described.
    assert.equal((await secrets.describe({ id }))?.email, undefined);

    await assert.rejects(secrets.update({ id }, { secret: 'x' }), {
      code: 'credential_invalid',
      message:
        'A GIT credential requires username, email and carries no other field.',
    });
    await assert.rejects(secrets.update({ id }, { kind: 'API_TOKEN' }), {
      code: 'credential_kind_immutable',
    });
    await assert.rejects(secrets.update({ id: 'missing' }, { name: 'x' }), {
      code: 'credential_missing',
    });
    assert.equal((await secrets.resolve({ id })).name, 'renamed');
  });
});

void test('a create breaking the kind field rule stores nothing', async () => {
  await withSecrets(async (secrets, host) => {
    await assert.rejects(
      secrets.create({
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
        secret: 'x',
      }),
      {
        code: 'credential_invalid',
        message:
          'A GIT credential requires username, email and carries no other field.',
      },
    );
    assert.deepEqual(
      await host.platform.services.use(SecretsBackendV1).list(),
      [],
    );
    assert.deepEqual(await secrets.list(), []);
  });
});

void test('a name already taken by the same kind is credential_name_taken', async () => {
  await withSecrets(async (secrets) => {
    await secrets.create({ kind: 'API_TOKEN', name: 'key', secret: 'a' });

    await assert.rejects(
      secrets.create({ kind: 'API_TOKEN', name: 'key', secret: 'b' }),
      { code: 'credential_name_taken' },
    );
    assert.deepEqual(await secrets.redactions(), ['a']);
  });
});

void test('without a key a secret cannot be written, while a kind without one can', async () => {
  await withSecrets(
    async (secrets) => {
      await assert.rejects(
        secrets.create({ kind: 'API_TOKEN', name: 'key', secret: 'x' }),
        {
          code: 'credential_storage_unavailable',
          message:
            'DORIC_CREDENTIAL_KEY is required to store a credential secret.',
        },
      );

      const identity = await secrets.create({
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
      });

      assert.deepEqual(
        (await secrets.list()).map(({ id }) => id),
        [identity.id],
      );
    },
    { keyConfigured: false },
  );
});

void test('resolving by kind answers none, the one, or refuses to guess; excluded IDs do not count', async () => {
  await withSecrets(async (secrets) => {
    assert.equal(await secrets.resolveByKind('API_TOKEN'), undefined);

    const provider = await secrets.create({
      kind: 'API_TOKEN',
      name: 'openrouter',
      secret: 'sk_provider',
    });

    assert.equal(
      (await secrets.resolveByKind('API_TOKEN'))?.secret,
      'sk_provider',
    );
    assert.equal(
      await secrets.resolveByKind('API_TOKEN', { exclude: [provider.id] }),
      undefined,
    );

    await secrets.create({ kind: 'API_TOKEN', name: 'github', secret: 'ghp' });

    await assert.rejects(secrets.resolveByKind('API_TOKEN'), {
      code: 'credential_ambiguous',
      message:
        'More than one API_TOKEN credential is stored; name the one to use.',
    });
    assert.equal(
      (await secrets.resolveByKind('API_TOKEN', { exclude: [provider.id] }))
        ?.secret,
      'ghp',
    );
    assert.equal(await secrets.resolveByKind('GIT'), undefined);
  });
});

void test('a deleted credential stops resolving at once; a missing one is missing', async () => {
  await withSecrets(async (secrets) => {
    const { id } = await secrets.create({
      kind: 'API_TOKEN',
      name: 'openrouter',
      secret: 'sk_secret',
    });

    assert.equal(await secrets.delete({ id }), 'deleted');
    await assert.rejects(secrets.resolve({ id }), {
      code: 'credential_missing',
    });
    assert.equal(await secrets.resolveByKind('API_TOKEN'), undefined);
    assert.deepEqual(await secrets.redactions(), []);
    assert.equal(await secrets.delete({ id }), 'missing');
  });
});

void test('a credential a reference source names is not deleted until the source lets it go', async () => {
  await withSecrets(async (secrets) => {
    const { id } = await secrets.create({
      kind: 'API_TOKEN',
      name: 'openrouter',
      secret: 'sk_secret',
    });
    let named: string[] = [id];
    const registration = secrets.registerReferences(() => named);

    assert.equal(await secrets.delete({ id }), 'referenced');
    assert.equal((await secrets.resolve({ id })).secret, 'sk_secret');

    named = [];
    assert.equal(await secrets.delete({ id }), 'deleted');

    const second = await secrets.create({
      kind: 'API_TOKEN',
      name: 'other',
      secret: 'x',
    });

    named = [second.id];
    registration.dispose();
    assert.equal(await secrets.delete({ id: second.id }), 'deleted');
  });
});

// R-2.1 (revised): secrets/v1.watchRedactions, the change notice the
// terminal's synchronous chunk redaction keeps its snapshot with.

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;

  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out.');
    await new Promise((done) => setTimeout(done, 1));
  }
};

void test('watchRedactions delivers the current list, then the list after every change', async () => {
  await withSecrets(
    async (secrets) => {
      const lists: (readonly string[])[] = [];
      const watch = secrets.watchRedactions((list) => {
        lists.push(list);
      });

      await until(() => lists.length === 1);
      assert.deepEqual(lists, [['sk_stored']]);

      const created = await secrets.create({
        kind: 'API_TOKEN',
        name: 'b',
        secret: 'sk_new',
      });

      assert.deepEqual(lists.at(-1), ['sk_stored', 'sk_new']);
      await secrets.update({ id: created.id }, { secret: 'sk_rotated' });
      assert.deepEqual(lists.at(-1), ['sk_stored', 'sk_rotated']);
      await secrets.delete({ id: '1' });
      assert.deepEqual(lists.at(-1), ['sk_rotated']);
      secrets.view().addRedaction('git-token');
      await until(() => lists.at(-1)?.includes('git-token') === true);
      assert.deepEqual(lists.at(-1), ['sk_rotated', 'git-token']);

      const count = lists.length;

      watch.dispose();
      await secrets.create({ kind: 'API_TOKEN', name: 'c', secret: 'sk_c' });
      assert.equal(lists.length, count);
    },
    { rows: [row('1', 'a', { secret: 'sk_stored' })] },
  );
});

void test('a write resolves only after every watcher received its list, and a failing watcher does not fail it', async () => {
  await withSecrets(async (secrets) => {
    let release: () => void = () => undefined;
    let received: readonly string[] | undefined;
    let ready = false;

    secrets.watchRedactions(() => {
      throw new Error('broken watcher');
    });
    secrets.watchRedactions((list) => {
      if (!ready) {
        ready = true;
        return;
      }
      received = list;
      // A remote listener answers a promise; the write waits for it.
      return new Promise<void>((resolve) => {
        release = resolve;
      }) as unknown as undefined;
    });
    await until(() => ready);

    let resolved = false;
    const write = secrets
      .create({ kind: 'API_TOKEN', name: 'a', secret: 'sk_a' })
      .then(() => {
        resolved = true;
      });

    await until(() => received !== undefined);
    assert.deepEqual(received, ['sk_a']);
    await new Promise((done) => setTimeout(done, 10));
    assert.equal(resolved, false);
    release();
    await write;
    assert.equal(resolved, true);
  });
});

void test('lists the built-in kinds and the kinds a registration holds', async () => {
  await withSecrets(async (secrets) => {
    assert.deepEqual(
      (await secrets.kinds()).map(({ id }) => id),
      ['API_TOKEN', 'USERNAME_PASSWORD', 'GIT'],
    );
  });
});

void test('refuses a kind another registration holds, and frees the name once disposed', async () => {
  await withSecrets(async (secrets) => {
    const duplicate = (error: unknown) =>
      isContractError(error) && error.code === 'duplicate_credential_kind';

    assert.throws(
      () =>
        secrets.registerKind({
          id: 'API_TOKEN',
          required: ['secret'],
          optional: [],
        }),
      duplicate,
    );

    const pair = secrets.registerKind({
      id: 'TOKEN_PAIR',
      required: ['secret'],
      optional: ['username'],
    });

    assert.throws(
      () =>
        secrets.registerKind({
          id: 'TOKEN_PAIR',
          required: ['secret'],
          optional: [],
        }),
      duplicate,
    );

    pair.dispose();
    secrets.registerKind({
      id: 'TOKEN_PAIR',
      required: ['secret'],
      optional: [],
    });

    assert.equal(
      (await secrets.kinds()).some(({ id }) => id === 'TOKEN_PAIR'),
      true,
    );
  });
});

void test('lists a stored kind nothing registers, and refuses to resolve or write it', async () => {
  await withSecrets(async (secrets) => {
    const pair = secrets.registerKind({
      id: 'TOKEN_PAIR',
      required: ['secret'],
      optional: [],
    });
    const stored = await secrets.create({
      kind: 'TOKEN_PAIR',
      name: 'pair',
      secret: 'sk_pair',
    });

    pair.dispose();

    assert.deepEqual(await secrets.list(), [stored]);

    const unknown = (error: unknown) =>
      isContractError(error) && error.code === 'unknown_kind';

    await assert.rejects(secrets.resolve({ id: stored.id }), unknown);
    await assert.rejects(secrets.resolveByKind('TOKEN_PAIR'), unknown);
    await assert.rejects(
      secrets.create({ kind: 'TOKEN_PAIR', name: 'other', secret: 'x' }),
      unknown,
    );
  });
});
