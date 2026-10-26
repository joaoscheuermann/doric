// The Claude sign-in over `claude.login/v1` answers the window as the
// `/credentials` routes answered their writes: `start` names the page the
// browser opens, `finish` the credential it stored — the public view, never
// the secret — and a refusal shows the contract's own message.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError, type CredentialDescription } from 'bundle/contracts';

import { settingsOver, showing } from './support/host.js';

const claude: CredentialDescription = {
  id: '00000000-0000-4000-8000-0000000000cc',
  kind: 'API_TOKEN',
  name: 'Claude',
  hasSecret: true,
};

const authorizeUrl = 'https://claude.com/cai/oauth/authorize?state=s';

describe('signing in with Claude', () => {
  test('start answers the authorization page the browser opens', async () => {
    await settingsOver(
      { claudeStart: () => ({ url: authorizeUrl }) },
      async (api) => {
        assert.equal(await api.claude.start(), authorizeUrl);
      },
    );
  });

  test('finish answers the public view of the credential it stored', async () => {
    await settingsOver({ claudeFinish: () => claude }, async (api) => {
      const signedIn = await api.claude.finish();

      assert.deepEqual(signedIn, claude);
      assert.equal('secret' in signedIn, false);
    });
  });

  for (const [code, message] of [
    ['claude_login_busy', 'A Claude sign-in is already in progress.'],
    ['claude_login_aborted', 'The Claude sign-in was cancelled.'],
    ['claude_login_failed', 'The Claude sign-in failed: access_denied'],
  ] as const) {
    test(`a ${code} refusal shows its own message`, async () => {
      await settingsOver(
        {
          claudeFinish: () => {
            throw new ContractError(code, message);
          },
        },
        async (api) => {
          await assert.rejects(api.claude.finish(), showing(message));
        },
      );
    });
  }

  test('a failure that is not the contract shows the generic message', async () => {
    await settingsOver(
      {
        claudeStart: () => {
          throw new Error('the bridge is gone');
        },
      },
      async (api) => {
        await assert.rejects(
          api.claude.start(),
          showing('The request could not be completed.'),
        );
      },
    );
  });
});
