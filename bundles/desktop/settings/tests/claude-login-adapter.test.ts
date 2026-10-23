// The Claude sign-in over `claude.login/v1` answers the window with the
// credential it stored, as the `/credentials` routes answered their writes:
// the busy refusal and the cancellation show their own messages, and the
// answer is the public view, never the secret.

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

describe('signing in with Claude', () => {
  test('answers the public view of the credential it stored', async () => {
    await settingsOver({ claudeLogin: () => claude }, async (api) => {
      const signedIn = await api.claude.login();

      assert.deepEqual(signedIn, claude);
      assert.equal('secret' in signedIn, false);
    });
  });

  test('a sign-in already running shows its own message', async () => {
    await settingsOver(
      {
        claudeLogin: () => {
          throw new ContractError(
            'claude_login_busy',
            'A Claude sign-in is already in progress.',
          );
        },
      },
      async (api) => {
        await assert.rejects(
          api.claude.login(),
          showing('A Claude sign-in is already in progress.'),
        );
      },
    );
  });

  test('a cancelled sign-in shows its own message', async () => {
    await settingsOver(
      {
        claudeLogin: () => {
          throw new ContractError(
            'claude_login_aborted',
            'The Claude sign-in was cancelled.',
          );
        },
      },
      async (api) => {
        await assert.rejects(
          api.claude.login(),
          showing('The Claude sign-in was cancelled.'),
        );
      },
    );
  });

  test('a failure that is not the contract shows the generic message', async () => {
    await settingsOver(
      {
        claudeLogin: () => {
          throw new Error('the bridge is gone');
        },
      },
      async (api) => {
        await assert.rejects(
          api.claude.login(),
          showing('The request could not be completed.'),
        );
      },
    );
  });
});
