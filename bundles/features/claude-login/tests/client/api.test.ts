// The sign-in calls the claude-login element makes (bundle isolation 6(a)),
// moved from settings' `tests/claude-login-adapter.test.ts`: over one
// activation's services, `start` names the page the browser opens, `finish`
// the credential the host stored — the public view, never the secret — and
// `openBrowser` asks `doric.browser/v1`. A rejection is a `ClientError` of
// `desktop/reads`: a refusal of the contract keeps its code and message with
// the contract error as `cause` (T-22, error-messages.md §6.4); an `internal`
// one keeps its message, no cause; anything else is `internal` with the
// generic message.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type AnyServiceRef,
  type ApiOf,
  ContractError,
  type CredentialDescription,
  DoricBrowserV1,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import { ClientError } from 'desktop/reads';

import {
  type ClaudeLoginApi,
  createClaudeLoginApi,
} from '../../src/client/api.js';
import { claudeLoginMethods } from '../../src/contracts/index.js';

const claude: CredentialDescription = {
  id: '00000000-0000-4000-8000-0000000000cc',
  kind: 'API_TOKEN',
  name: 'Claude',
  hasSecret: true,
};

const authorizeUrl = 'https://claude.com/cai/oauth/authorize?state=s';

/** What the fake host answers; an absent answer fails the call. */
interface FakeHost {
  readonly start?: () => { readonly url: string };
  readonly finish?: () => CredentialDescription;
  readonly open?: (url: string) => void;
}

const unanswered = (): never => {
  throw new Error('The fake host was not given this answer.');
};

/**
 * The api over a `claude.login/v1` fake served with its own schemas, and a
 * hand-made `doric.browser/v1`: that contract ID is reserved for the platform,
 * so a bundle's test cannot define a service for it.
 */
const apiOver = async (
  host: FakeHost,
  run: (api: ClaudeLoginApi) => Promise<void>,
): Promise<void> => {
  const login = createTestServices({
    bundle: { id: 'claude-login' },
    provide: [
      defineService('claude.login/v1', {
        start: defineMethod({
          input: claudeLoginMethods.start.input,
          output: claudeLoginMethods.start.output,
          execute: async () => (host.start ?? unanswered)(),
        }),
        finish: defineMethod({
          input: claudeLoginMethods.finish.input,
          output: claudeLoginMethods.finish.output,
          execute: async () => (host.finish ?? unanswered)(),
        }),
      }),
    ],
  });
  const browser: ApiOf<typeof DoricBrowserV1> = {
    open: async (url: string) => (host.open ?? unanswered)(url),
  } as ApiOf<typeof DoricBrowserV1>;
  const services: Services = {
    ...login.services,
    use: <R extends AnyServiceRef>(contract: R) =>
      contract.id === DoricBrowserV1.id
        ? (browser as ApiOf<R>)
        : login.services.use(contract),
  };
  try {
    await run(createClaudeLoginApi(services));
  } finally {
    await login.dispose();
  }
};

/** A `ClientError` with exactly this code, message and cause. */
const clientError =
  (expected: {
    readonly code: string;
    readonly message: string;
    readonly cause: unknown;
  }) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof ClientError, `not a ClientError: ${error}`);
    assert.equal(error.code, expected.code);
    assert.equal(error.message, expected.message);
    assert.equal(
      error.cause,
      expected.cause,
      expected.cause === undefined ? 'a cause is kept' : 'the cause differs',
    );
    return true;
  };

describe('the sign-in api', () => {
  test('start answers the authorization page the browser opens', async () => {
    await apiOver({ start: () => ({ url: authorizeUrl }) }, async (api) => {
      assert.equal(await api.start(), authorizeUrl);
    });
  });

  test('finish answers the public view of the credential it stored, unchanged', async () => {
    await apiOver({ finish: () => claude }, async (api) => {
      const signedIn = await api.finish();

      assert.deepEqual(signedIn, claude);
      assert.equal('secret' in signedIn, false);
    });
  });

  test('openBrowser asks doric.browser/v1 to open the page', async () => {
    const opened: string[] = [];
    await apiOver({ open: (url) => void opened.push(url) }, async (api) => {
      await api.openBrowser(authorizeUrl);
    });

    assert.deepEqual(opened, [authorizeUrl]);
  });
});

describe('T-22 sign-in rejections keep their code and cause', () => {
  for (const [code, message] of [
    ['claude_login_busy', 'A Claude sign-in is already in progress.'],
    ['claude_login_aborted', 'The Claude sign-in was cancelled.'],
    ['claude_login_failed', 'The Claude sign-in failed: access_denied'],
  ] as const) {
    test(`a ${code} refusal keeps its code and message, with the refusal as its cause`, async () => {
      const contract = new ContractError(code, message);
      await apiOver(
        {
          finish: () => {
            throw contract;
          },
        },
        async (api) => {
          await assert.rejects(
            api.finish(),
            clientError({ code, message, cause: contract }),
          );
        },
      );
    });
  }

  test('an internal refusal keeps its message, with no cause', async () => {
    await apiOver(
      {
        start: () => {
          throw new ContractError('internal', 'The login store is locked.');
        },
      },
      async (api) => {
        await assert.rejects(
          api.start(),
          clientError({
            code: 'internal',
            message: 'The login store is locked.',
            cause: undefined,
          }),
        );
      },
    );
  });

  test('a failure that is not the contract is internal, with the generic message and no cause', async () => {
    await apiOver(
      {
        start: () => {
          throw new Error('the bridge is gone');
        },
      },
      async (api) => {
        await assert.rejects(
          api.start(),
          clientError({
            code: 'internal',
            message: 'The request could not be completed.',
            cause: undefined,
          }),
        );
      },
    );
  });
});
