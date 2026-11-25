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
  type ApiOf,
  type ClientServices,
  ContractError,
  type CredentialDescription,
  DoricBrowserV1,
} from 'bundle/contracts';
import { ClientError } from 'desktop/reads';

import {
  type ClaudeLoginApi,
  createClaudeLoginApi,
} from '../../src/client/api.js';
import { LoginService } from '../../src/contracts/gen/doric/claude/login/v1/login_pb.js';
import {
  connectFailure,
  fakeClientServices,
  fakeHostClients,
  type HostCall,
} from './support/connect.js';

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
 * Runs `answer`: a `ContractError` it throws fails the call as the host
 * sends it (`toConnectError`, with the Doric error detail); anything else
 * is thrown as it is, a failure that is not the contract's.
 */
const answered = async <T>(answer: () => T): Promise<T> => {
  try {
    return answer();
  } catch (error) {
    throw error instanceof ContractError ? connectFailure(error) : error;
  }
};

/**
 * The api over `claude.login/v1`'s `LoginService`, served over Connect
 * (slice S65c) by a fake `HostClients`, and a hand-made `doric.browser/v1`:
 * that contract ID is reserved for the platform, and stays on the envelope.
 * `calls` are the window's host calls, in order.
 */
const apiOver = async (
  host: FakeHost,
  run: (api: ClaudeLoginApi, calls: readonly HostCall[]) => Promise<void>,
): Promise<void> => {
  const { hostClients, calls } = fakeHostClients((router) => {
    router.service(LoginService, {
      start: () => answered(() => (host.start ?? unanswered)()),
      finish: () =>
        answered(() => ({
          credentialDescription: (host.finish ?? unanswered)(),
        })),
    });
  });
  const window = fakeClientServices({
    bundleId: 'claude-login',
    hostClients,
  });
  const browser: ApiOf<typeof DoricBrowserV1> = {
    open: async (url: string) => (host.open ?? unanswered)(url),
  } as ApiOf<typeof DoricBrowserV1>;
  const services = {
    ...window.services,
    use: (contract: unknown, scope?: never) =>
      contract === DoricBrowserV1
        ? browser
        : window.services.use(contract as typeof DoricBrowserV1, scope),
  } as unknown as ClientServices;
  await run(createClaudeLoginApi(services), calls);
};

/** A `ClientError` with exactly this code, message and cause. */
const clientError =
  (expected: {
    readonly code: string;
    readonly message: string;
    readonly cause:
      | { readonly code: string; readonly message: string }
      | undefined;
  }) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof ClientError, `not a ClientError: ${error}`);
    assert.equal(error.code, expected.code);
    assert.equal(error.message, expected.message);
    if (expected.cause === undefined) {
      assert.equal(error.cause, undefined, 'a cause is kept');
    } else {
      // Over Connect the cause is the contract error the client read
      // (`fromConnectError`): the host's code and message, not its instance.
      assert.ok(error.cause instanceof ContractError, 'the cause differs');
      assert.equal(error.cause.code, expected.cause.code);
      assert.equal(error.cause.message, expected.cause.message);
    }
    return true;
  };

describe('the sign-in api', () => {
  test('start answers the authorization page the browser opens', async () => {
    await apiOver(
      { start: () => ({ url: authorizeUrl }) },
      async (api, calls) => {
        assert.equal(await api.start(), authorizeUrl);
        // Over Connect, as the claude-login part (slice S65c).
        assert.deepEqual(calls, [
          {
            method: 'doric.claude.login.v1.LoginService/Start',
            part: 'claude-login',
          },
        ]);
      },
    );
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
