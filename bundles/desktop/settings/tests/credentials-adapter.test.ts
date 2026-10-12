// Credential writes over `secrets/v1` answer the window with the messages the
// `/credentials` routes sent, and no secret ever comes back.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError, type CredentialDescription } from 'bundle/contracts';

import { settingsOver, showing } from './support/host.js';

const id = '00000000-0000-4000-8000-0000000000aa';

const token: CredentialDescription = {
  id,
  kind: 'API_TOKEN',
  name: 'OpenRouter',
  hasSecret: true,
};

describe('removing a credential', () => {
  test('a credential a configuration still names is refused with the conflict text', async () => {
    await settingsOver({ delete: () => 'referenced' }, async (api) => {
      await assert.rejects(
        api.credentials.remove(id),
        showing('The credential cannot perform this operation.'),
      );
    });
  });

  test('a credential that no longer exists is reported as not found', async () => {
    await settingsOver({ delete: () => 'missing' }, async (api) => {
      await assert.rejects(
        api.credentials.remove(id),
        showing('The credential was not found.'),
      );
    });
  });

  test('a removed credential resolves with nothing', async () => {
    const removed: string[] = [];

    await settingsOver(
      {
        delete: (ref) => {
          removed.push(ref.id);
          return 'deleted';
        },
      },
      async (api) => {
        assert.equal(await api.credentials.remove(id), undefined);
      },
    );

    assert.deepEqual(removed, [id]);
  });

  test('an id that is not a credential id is refused without asking the host', async () => {
    let asked = false;

    await settingsOver(
      {
        delete: () => {
          asked = true;
          return 'deleted';
        },
      },
      async (api) => {
        await assert.rejects(
          api.credentials.remove('not-a-uuid'),
          showing('The credential ID is invalid.'),
        );
      },
    );

    assert.equal(asked, false);
  });
});

describe('writing a credential', () => {
  test('a create answers the public view, never the secret', async () => {
    let received: unknown;

    await settingsOver(
      {
        create: (input) => {
          received = input;
          return token;
        },
      },
      async (api) => {
        const created = await api.credentials.create({
          kind: 'API_TOKEN',
          name: ' OpenRouter ',
          secret: 'sk-live',
        });

        assert.deepEqual(created, token);
        assert.equal('secret' in created, false);
      },
    );

    assert.deepEqual(received, {
      kind: 'API_TOKEN',
      name: 'OpenRouter',
      secret: 'sk-live',
    });
  });

  test('fields that do not match the kind are refused before the host', async () => {
    await settingsOver({}, async (api) => {
      await assert.rejects(
        api.credentials.create({ kind: 'GIT', name: 'Me', secret: 'x' }),
        showing('The credential does not match its kind.'),
      );
    });
  });

  test('a malformed secret is refused by the window guard', async () => {
    await settingsOver({}, async (api) => {
      await assert.rejects(
        api.credentials.create({
          kind: 'API_TOKEN',
          name: 'Token',
          secret: 'has space',
        }),
        showing('The configuration is invalid.'),
      );
      await assert.rejects(
        api.credentials.create({
          kind: 'API_TOKEN',
          name: '',
          secret: 'x',
        }),
        showing('The credential is invalid.'),
      );
    });
  });

  for (const [code, message] of [
    ['credential_name_taken', 'The credential cannot perform this operation.'],
    [
      'credential_kind_immutable',
      'The credential cannot perform this operation.',
    ],
    ['credential_missing', 'The credential was not found.'],
    [
      'credential_storage_unavailable',
      'The host cannot store credential secrets.',
    ],
  ] as const) {
    test(`the host refusal ${code} shows the route's text`, async () => {
      await settingsOver(
        {
          update: () => {
            throw new ContractError(code, 'internal wording');
          },
        },
        async (api) => {
          await assert.rejects(
            api.credentials.update(id, { name: 'Renamed' }),
            showing(message),
          );
        },
      );
    });
  }

  test('an invalid credential shows the reason the host gave', async () => {
    await settingsOver(
      {
        create: () => {
          throw new ContractError(
            'credential_invalid',
            'A GIT credential needs a username and an email.',
          );
        },
      },
      async (api) => {
        await assert.rejects(
          api.credentials.create({
            kind: 'GIT',
            name: 'Me',
            username: 'me',
            email: 'me@example.com',
          }),
          showing('A GIT credential needs a username and an email.'),
        );
      },
    );
  });

  test('an update keeps an absent field and clears an empty one', async () => {
    let received: unknown;

    await settingsOver(
      {
        update: (_ref, input) => {
          received = input;
          return token;
        },
      },
      async (api) => {
        await api.credentials.update(id, { secret: '', name: 'Renamed' });
      },
    );

    assert.deepEqual(received, {
      name: 'Renamed',
      username: null,
      email: null,
      secret: '',
    });
  });
});

describe('listing credentials', () => {
  test('lists every credential in its public shape', async () => {
    await settingsOver(
      {
        list: () => [
          token,
          {
            id,
            kind: 'GIT',
            name: 'Me',
            username: 'me',
            email: 'me@x.io',
            hasSecret: false,
          },
        ],
      },
      async (api) => {
        assert.deepEqual(
          (await api.credentials.list()).map((entry) => entry.name),
          ['OpenRouter', 'Me'],
        );
      },
    );
  });
});
