// `secrets/v1` served by `core` over the router (S39b): the port of
// `../secrets.test.ts` onto `createCoreServices` and `createTestRouter`.
//
// Router decisions (S39 contracts, gaps 7 and 8): credentials load on the
// first secrets call; a reference source is the registrant's
// `ReferenceSourceService` (the harness fake answers `core.references`), and
// one that fails fails the `Delete`, which then removes nothing. There is no
// in-process `view`: `ListSecrets`, `Redactions` and `AddRedaction` replace
// it, and `WatchRedactions` is a stream of the complete list.

import assert from 'node:assert/strict';
import test from 'node:test';

import { type Client, ConnectError } from '@connectrpc/connect';
import { fromConnectError, type StoredSecret } from 'bundle/contracts';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import type { MemorySecretsOptions } from 'storage/memory';

import { type RoutedCore, serveCore } from '../support/router.js';

type Secrets = Client<typeof SecretsService>;

/** The GIT kind as the git bundle registers it when it activates. */
const gitKind = { id: 'GIT', required: ['username', 'email'], optional: [] };

/**
 * `core` served with `memory` as the secrets backend, the GIT kind
 * registered by `git`, and `secrets` the platform's (`doric`) client.
 */
const withSecrets = async (
  run: (secrets: Secrets, core: RoutedCore) => Promise<void>,
  memory: MemorySecretsOptions = {},
) => {
  const core = await serveCore({
    bundles: { git: [], notes: [], pairs: [] },
    secretsOptions: memory,
  });

  try {
    await core
      .client(SecretsService, 'git')
      .registerKind({ credentialKindDefinition: gitKind });
    await run(core.client(SecretsService, 'doric'), core);
  } finally {
    await core.close();
  }
};

const row = (
  id: string,
  name: string,
  fields: Partial<StoredSecret> = {},
): StoredSecret => ({ id, kind: 'API_TOKEN', name, secret: '', ...fields });

/** A message as plain data: no `$typeName`, no absent optional field. */
const plain = (message: object | undefined): unknown => {
  if (message === undefined) return undefined;

  const { $typeName: _, ...rest } = message as Record<string, unknown>;

  return JSON.parse(JSON.stringify(rest)) as unknown;
};

const rejectsWith = async (
  promise: Promise<unknown>,
  code: string,
  message?: string,
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectError, `not a ConnectError: ${error}`);

    const contract = fromConnectError(error);

    assert.equal(contract.code, code, error.message);

    if (message !== undefined) {
      assert.equal(contract.message, message);
    }

    return true;
  });
};

const ref = (id: string) => ({ credentialRef: { id } });

const names = async (secrets: Secrets) =>
  (await secrets.list({})).credentials.map(({ name }) => name);

const redactionsOf = async (secrets: Secrets) =>
  (await secrets.redactions({})).redactions;

void test('a stored secret resolves for the host while its description only says it exists', async () => {
  await withSecrets(async (secrets, core) => {
    const created = (
      await secrets.create({
        kind: 'API_TOKEN',
        name: 'openrouter',
        secret: 'sk_secret',
      })
    ).credentialDescription;

    assert.ok(created !== undefined);
    assert.deepEqual(plain(created), {
      id: created.id,
      kind: 'API_TOKEN',
      name: 'openrouter',
      hasSecret: true,
    });
    assert.equal(JSON.stringify(plain(created)).includes('sk_secret'), false);
    assert.equal(
      (await secrets.resolve(ref(created.id))).secret?.secret,
      'sk_secret',
    );
    assert.deepEqual(
      plain((await secrets.describe(ref(created.id))).credentialDescription),
      plain(created),
    );
    assert.deepEqual(
      (await secrets.list({})).credentials.map(plain),
      [plain(created)],
    );
    assert.deepEqual(await redactionsOf(secrets), ['sk_secret']);

    // The backend stored the row the service wrote.
    assert.equal(
      (await core.secretsBackend.get(created.id))?.secret,
      'sk_secret',
    );
  });
});

void test('an unknown reference is credential_missing and a description of it is absent', async () => {
  await withSecrets(async (secrets) => {
    await rejectsWith(
      secrets.resolve(ref('nope')),
      'credential_missing',
      'Credential nope is not stored.',
    );
    assert.equal(
      (await secrets.describe(ref('nope'))).credentialDescription,
      undefined,
    );
  });
});

void test('the list keeps the backend order at load, sorts by name after a save, and keeps it after a removal', async () => {
  await withSecrets(
    async (secrets) => {
      assert.deepEqual(await names(secrets), ['B', 'a', 'b']);

      assert.equal((await secrets.delete(ref('2'))).result, 'deleted');
      assert.deepEqual(await names(secrets), ['B', 'b']);

      await secrets.create({ kind: 'API_TOKEN', name: 'c', secret: 'x' });
      assert.deepEqual(await names(secrets), ['b', 'B', 'c']);
    },
    { rows: [row('1', 'b'), row('2', 'a'), row('3', 'B')] },
  );
});

void test('a stored secret without a key refuses the load; an empty secret does not', async () => {
  await withSecrets(
    async (secrets) => {
      await rejectsWith(
        secrets.list({}),
        'credential_key_required',
        'DORIC_CREDENTIAL_KEY is required while a stored credential holds a secret.',
      );
    },
    {
      keyConfigured: false,
      rows: [row('1', 'openrouter', { secret: 'v1:AAAA:BBBB:CCCC' })],
    },
  );

  await withSecrets(
    async (secrets) => {
      assert.equal(
        (await secrets.resolve(ref('1'))).secret?.name,
        'openrouter',
      );
      assert.deepEqual(await redactionsOf(secrets), []);
    },
    { keyConfigured: false, rows: [row('1', 'openrouter')] },
  );
});

void test('ListSecrets, Redactions and AddRedaction replace the in-process view: an added secret follows the stored ones', async () => {
  await withSecrets(
    async (secrets) => {
      assert.deepEqual(await redactionsOf(secrets), ['sk_stored']);

      await secrets.addRedaction({ secret: 'ghp_learned_in_a_sandbox' });
      // An empty secret breaks the contract (min_len 1) and changes nothing.
      await rejectsWith(secrets.addRedaction({ secret: '' }), 'invalid_input');

      assert.deepEqual(await redactionsOf(secrets), [
        'sk_stored',
        'ghp_learned_in_a_sandbox',
      ]);

      // The list follows later writes.
      await secrets.create({ kind: 'API_TOKEN', name: 'a', secret: 'sk_new' });
      assert.deepEqual(await redactionsOf(secrets), [
        'sk_new',
        'sk_stored',
        'ghp_learned_in_a_sandbox',
      ]);
      assert.deepEqual(
        (await secrets.listSecrets({})).secrets.map(({ name, secret }) => [
          name,
          secret,
        ]),
        [
          ['a', 'sk_new'],
          ['openrouter', 'sk_stored'],
        ],
      );
    },
    { rows: [row('1', 'openrouter', { secret: 'sk_stored' })] },
  );
});

void test('an update keeps an absent field, sets any string, and keeps the kind', async () => {
  await withSecrets(async (secrets) => {
    const created = (
      await secrets.create({
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
      })
    ).credentialDescription;

    assert.ok(created !== undefined);

    const { id } = created;
    const kept = await secrets.update({
      ref: { id },
      update: { name: 'renamed' },
    });

    assert.deepEqual(plain(kept.credentialDescription), {
      id,
      kind: 'GIT',
      name: 'renamed',
      username: 'octocat',
      email: 'octocat@example.com',
      hasSecret: false,
    });

    await secrets.update({ ref: { id }, update: { email: '' } });
    assert.deepEqual(plain((await secrets.resolve(ref(id))).secret), {
      id,
      kind: 'GIT',
      name: 'renamed',
      username: 'octocat',
      email: '',
    });
    // An empty email is not described.
    assert.equal(
      (await secrets.describe(ref(id))).credentialDescription?.email,
      undefined,
    );

    await rejectsWith(
      secrets.update({ ref: { id }, update: { secret: 'x' } }),
      'credential_invalid',
      'A GIT credential requires username, email and carries no other field.',
    );
    await rejectsWith(
      secrets.update({ ref: { id }, update: { kind: 'API_TOKEN' } }),
      'credential_kind_immutable',
    );
    await rejectsWith(
      secrets.update({ ref: { id: 'missing' }, update: { name: 'x' } }),
      'credential_missing',
    );
    assert.equal((await secrets.resolve(ref(id))).secret?.name, 'renamed');
  });
});

void test('a create breaking the kind field rule stores nothing', async () => {
  await withSecrets(async (secrets, core) => {
    await rejectsWith(
      secrets.create({
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
        secret: 'x',
      }),
      'credential_invalid',
      'A GIT credential requires username, email and carries no other field.',
    );
    assert.deepEqual(await core.secretsBackend.list(), []);
    assert.deepEqual((await secrets.list({})).credentials, []);
  });
});

void test('a name already taken by the same kind is credential_name_taken', async () => {
  await withSecrets(async (secrets) => {
    await secrets.create({ kind: 'API_TOKEN', name: 'key', secret: 'a' });

    await rejectsWith(
      secrets.create({ kind: 'API_TOKEN', name: 'key', secret: 'b' }),
      'credential_name_taken',
    );
    assert.deepEqual(await redactionsOf(secrets), ['a']);
  });
});

void test('without a key a secret cannot be written, while a kind without one can', async () => {
  await withSecrets(
    async (secrets) => {
      await rejectsWith(
        secrets.create({ kind: 'API_TOKEN', name: 'key', secret: 'x' }),
        'credential_storage_unavailable',
        'DORIC_CREDENTIAL_KEY is required to store a credential secret.',
      );

      const identity = (
        await secrets.create({
          kind: 'GIT',
          name: 'github',
          username: 'octocat',
          email: 'octocat@example.com',
        })
      ).credentialDescription;

      assert.ok(identity !== undefined);
      assert.deepEqual(
        (await secrets.list({})).credentials.map(({ id }) => id),
        [identity.id],
      );
    },
    { keyConfigured: false },
  );
});

void test('resolving by kind answers none, the one, or refuses to guess; excluded IDs do not count', async () => {
  await withSecrets(async (secrets) => {
    const byKind = async (kind: string, exclude: string[] = []) =>
      (await secrets.resolveByKind({ kind, exclude })).secret?.secret;

    assert.equal(
      (await secrets.resolveByKind({ kind: 'API_TOKEN', exclude: [] })).secret,
      undefined,
    );

    const provider = (
      await secrets.create({
        kind: 'API_TOKEN',
        name: 'openrouter',
        secret: 'sk_provider',
      })
    ).credentialDescription;

    assert.ok(provider !== undefined);
    assert.equal(await byKind('API_TOKEN'), 'sk_provider');
    assert.equal(
      (
        await secrets.resolveByKind({
          kind: 'API_TOKEN',
          exclude: [provider.id],
        })
      ).secret,
      undefined,
    );

    await secrets.create({ kind: 'API_TOKEN', name: 'github', secret: 'ghp' });

    await rejectsWith(
      secrets.resolveByKind({ kind: 'API_TOKEN', exclude: [] }),
      'credential_ambiguous',
      'More than one API_TOKEN credential is stored; name the one to use.',
    );
    assert.equal(await byKind('API_TOKEN', [provider.id]), 'ghp');
    assert.equal(
      (await secrets.resolveByKind({ kind: 'GIT', exclude: [] })).secret,
      undefined,
    );
  });
});

void test('a deleted credential stops resolving at once; a missing one is missing', async () => {
  await withSecrets(async (secrets) => {
    const created = (
      await secrets.create({
        kind: 'API_TOKEN',
        name: 'openrouter',
        secret: 'sk_secret',
      })
    ).credentialDescription;

    assert.ok(created !== undefined);

    const { id } = created;

    assert.equal((await secrets.delete(ref(id))).result, 'deleted');
    await rejectsWith(secrets.resolve(ref(id)), 'credential_missing');
    assert.equal(
      (await secrets.resolveByKind({ kind: 'API_TOKEN', exclude: [] })).secret,
      undefined,
    );
    assert.deepEqual(await redactionsOf(secrets), []);
    assert.equal((await secrets.delete(ref(id))).result, 'missing');
  });
});

void test('a credential a reference source names is not deleted until the source lets it go; a failing source fails the delete', async () => {
  await withSecrets(async (secrets, core) => {
    const create = async (name: string) => {
      const created = (
        await secrets.create({ kind: 'API_TOKEN', name, secret: `sk_${name}` })
      ).credentialDescription;

      assert.ok(created !== undefined);

      return created.id;
    };
    const notes = core.client(SecretsService, 'notes');
    const first = await create('first');
    const { registrationId } = await notes.registerReferences({
      source: 'notes.refs',
    });

    core.references.set('notes.refs', [first]);
    assert.equal((await secrets.delete(ref(first))).result, 'referenced');
    assert.equal(
      (await secrets.resolve(ref(first))).secret?.secret,
      'sk_first',
    );
    assert.ok(core.referenceCalls.includes('notes.refs'));

    core.references.set('notes.refs', []);
    assert.equal((await secrets.delete(ref(first))).result, 'deleted');

    // Once the registration is gone, its source is no longer asked.
    const second = await create('second');

    core.references.set('notes.refs', [second]);
    await notes.unregister({ registrationId });
    assert.equal((await secrets.delete(ref(second))).result, 'deleted');

    // Gap 8: a source that cannot answer fails the delete, which removes
    // nothing.
    const third = await create('third');

    await notes.registerReferences({ source: 'notes.down' });
    core.failingSources.add('notes.down');
    await rejectsWith(secrets.delete(ref(third)), 'unavailable');
    assert.equal(
      (await secrets.resolve(ref(third))).secret?.secret,
      'sk_third',
    );
    assert.equal((await core.secretsBackend.get(third))?.secret, 'sk_third');
  });
});

// R-2.1 (revised): secrets/v1.WatchRedactions, the stream the terminal's
// synchronous chunk redaction keeps its snapshot with.

/** One open `WatchRedactions` stream, its items collected in `lists`. */
const watch = (secrets: Secrets) => {
  const controller = new AbortController();
  const state: {
    readonly lists: string[][];
    error: unknown;
    readonly cancel: () => void;
  } = {
    lists: [],
    error: undefined,
    cancel: () => {
      controller.abort();
    },
  };

  void (async () => {
    try {
      for await (const { redactions } of secrets.watchRedactions(
        {},
        { signal: controller.signal },
      )) {
        state.lists.push([...redactions]);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        state.error = error;
      }
    }
  })();

  return state;
};

/** Waits until `check` holds; fails at once with the stream's own error. */
const until = async (
  check: () => boolean,
  stream: { readonly error: unknown },
): Promise<void> => {
  const deadline = Date.now() + 2000;

  while (!check()) {
    if (stream.error !== undefined) throw stream.error;
    if (Date.now() > deadline) throw new Error('Timed out.');
    await new Promise((done) => setTimeout(done, 1));
  }
};

void test('WatchRedactions yields the current list, then the list after every change', async () => {
  await withSecrets(
    async (secrets) => {
      const stream = watch(secrets);

      await until(() => stream.lists.length === 1, stream);
      assert.deepEqual(stream.lists, [['sk_stored']]);

      const created = (
        await secrets.create({ kind: 'API_TOKEN', name: 'b', secret: 'sk_new' })
      ).credentialDescription;

      assert.ok(created !== undefined);
      await until(() => stream.lists.length === 2, stream);
      assert.deepEqual(stream.lists.at(-1), ['sk_stored', 'sk_new']);

      await secrets.update({
        ref: { id: created.id },
        update: { secret: 'sk_rotated' },
      });
      await until(() => stream.lists.length === 3, stream);
      assert.deepEqual(stream.lists.at(-1), ['sk_stored', 'sk_rotated']);

      await secrets.delete(ref('1'));
      await until(() => stream.lists.length === 4, stream);
      assert.deepEqual(stream.lists.at(-1), ['sk_rotated']);

      await secrets.addRedaction({ secret: 'git-token' });
      await until(() => stream.lists.length === 5, stream);
      assert.deepEqual(stream.lists.at(-1), ['sk_rotated', 'git-token']);

      stream.cancel();
      await secrets.create({ kind: 'API_TOKEN', name: 'c', secret: 'sk_c' });
      await new Promise((done) => setTimeout(done, 20));
      assert.equal(stream.lists.length, 5);
    },
    { rows: [row('1', 'a', { secret: 'sk_stored' })] },
  );
});

void test('a write resolves after every open stream got its list, and a cancelled stream does not fail it', async () => {
  await withSecrets(async (secrets) => {
    const cancelled = watch(secrets);
    const open = watch(secrets);

    await until(() => cancelled.lists.length === 1, cancelled);
    await until(() => open.lists.length === 1, open);
    cancelled.cancel();

    // Each write's list is queued before the write answers, so two writes in
    // a row reach the open stream as two items, in order.
    await secrets.create({ kind: 'API_TOKEN', name: 'a', secret: 'sk_a' });
    await secrets.create({ kind: 'API_TOKEN', name: 'b', secret: 'sk_b' });

    await until(() => open.lists.length === 3, open);
    assert.deepEqual(open.lists, [[], ['sk_a'], ['sk_a', 'sk_b']]);
    assert.deepEqual(cancelled.lists, [[]]);
    open.cancel();
  });
});

void test('Kinds lists the built-in kinds and the registered ones; a held kind is duplicate_credential_kind until unregistered', async () => {
  await withSecrets(async (secrets, core) => {
    const kinds = async () =>
      (await secrets.kinds({})).kinds.map(({ id }) => id);

    assert.deepEqual(await kinds(), ['API_TOKEN', 'USERNAME_PASSWORD', 'GIT']);

    const pairs = core.client(SecretsService, 'pairs');

    await rejectsWith(
      pairs.registerKind({
        credentialKindDefinition: {
          id: 'API_TOKEN',
          required: ['secret'],
          optional: [],
        },
      }),
      'duplicate_credential_kind',
    );

    const { registrationId } = await pairs.registerKind({
      credentialKindDefinition: {
        id: 'TOKEN_PAIR',
        required: ['secret'],
        optional: ['username'],
      },
    });

    await rejectsWith(
      pairs.registerKind({
        credentialKindDefinition: {
          id: 'TOKEN_PAIR',
          required: ['secret'],
          optional: [],
        },
      }),
      'duplicate_credential_kind',
    );

    await pairs.unregister({ registrationId });
    await pairs.registerKind({
      credentialKindDefinition: {
        id: 'TOKEN_PAIR',
        required: ['secret'],
        optional: [],
      },
    });

    assert.deepEqual(await kinds(), [
      'API_TOKEN',
      'USERNAME_PASSWORD',
      'GIT',
      'TOKEN_PAIR',
    ]);
  });
});

void test('a stored kind nothing registers is listed, but Resolve, ResolveByKind, Create and Update refuse it', async () => {
  await withSecrets(async (secrets, core) => {
    const pairs = core.client(SecretsService, 'pairs');
    const { registrationId } = await pairs.registerKind({
      credentialKindDefinition: {
        id: 'TOKEN_PAIR',
        required: ['secret'],
        optional: [],
      },
    });
    const stored = (
      await secrets.create({ kind: 'TOKEN_PAIR', name: 'pair', secret: 'sk_pair' })
    ).credentialDescription;

    assert.ok(stored !== undefined);
    await pairs.unregister({ registrationId });

    assert.deepEqual(
      (await secrets.list({})).credentials.map(plain),
      [plain(stored)],
    );
    await rejectsWith(secrets.resolve(ref(stored.id)), 'unknown_kind');
    await rejectsWith(
      secrets.resolveByKind({ kind: 'TOKEN_PAIR', exclude: [] }),
      'unknown_kind',
    );
    await rejectsWith(
      secrets.create({ kind: 'TOKEN_PAIR', name: 'other', secret: 'x' }),
      'unknown_kind',
    );
    await rejectsWith(
      secrets.update({ ref: { id: stored.id }, update: { name: 'renamed' } }),
      'unknown_kind',
    );
  });
});
