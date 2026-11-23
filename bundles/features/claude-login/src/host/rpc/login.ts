// `claude.login/v1` served through the router (phase 3, slice S50b): the
// sign-in sessions of `login.ts` with the authorization stored through a
// routed `secrets/v1` client.

import type { Client, ServiceImpl } from '@connectrpc/connect';
import { ContractError, isContractError } from 'bundle/contracts';
import {
  type CredentialDescription,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { contractErrorOf, type HostContext } from 'bundle/host';

import type { LoginService } from '../../contracts/gen/doric/claude/login/v1/login_pb.js';
import {
  CLAUDE_CREDENTIAL_NAME,
  type ClaudeLoginDeps,
  createLoginSessions,
} from '../login.js';

/** The kind the Claude authorization is stored as. */
const API_TOKEN = 'API_TOKEN';

/** A `secrets/v1` answer's description, or `invalid_output` without one. */
const describedBy = (answer: {
  readonly credentialDescription?: CredentialDescription;
}): CredentialDescription => {
  if (answer.credentialDescription === undefined) {
    throw new ContractError(
      'invalid_output',
      'secrets/v1 answered without a credential description.',
    );
  }
  return answer.credentialDescription;
};

/**
 * Stores `authorization` as the `API_TOKEN` credential named `Claude` through
 * `secrets/v1`, and answers the stored credential's public view:
 * - `Create{kind: 'API_TOKEN', name: 'Claude', secret: authorization}`;
 * - when that fails `credential_name_taken`: `List{}`, then
 *   `Update{ref: {id}, update: {secret: authorization}}` for the listed
 *   credential of kind `API_TOKEN` and name `Claude`.
 *
 * Each call inherits the scope, deadline and signal of the handler's call.
 *
 * Failures:
 * - `credential_name_taken` when `List` names no such credential;
 * - any other failure as `contractErrorOf` reads it;
 * - `invalid_output` when an answer has no `credentialDescription`.
 */
export const storeClaudeAuthorization = async (
  secrets: Client<typeof SecretsService>,
  authorization: string,
): Promise<CredentialDescription> => {
  let taken: unknown;
  try {
    return describedBy(
      await secrets.create({
        kind: API_TOKEN,
        name: CLAUDE_CREDENTIAL_NAME,
        secret: authorization,
      }),
    );
  } catch (error) {
    taken = contractErrorOf(error);
    if (!isContractError(taken) || taken.code !== 'credential_name_taken') {
      throw taken;
    }
  }
  try {
    const listed = await secrets.list({});
    const existing = listed.credentials.find(
      (credential) =>
        credential.kind === API_TOKEN &&
        credential.name === CLAUDE_CREDENTIAL_NAME,
    );
    if (existing === undefined) throw taken;
    return describedBy(
      await secrets.update({
        ref: { id: existing.id },
        update: { secret: authorization },
      }),
    );
  } catch (error) {
    throw contractErrorOf(error);
  }
};

export interface ClaudeLoginServiceOptions {
  /** The OAuth seams; the real pieces by default. Tests inject fakes. */
  readonly deps?: ClaudeLoginDeps;
}

export interface ClaudeLoginServiceHandle {
  /**
   * `claude.login/v1` (1.1.0), over one `createLoginSessions(options.deps)`:
   * - `Start` → `{url}` from `sessions.start(context.signal)`;
   * - `Finish` → `{credentialDescription}` from
   *   `sessions.finish(context.signal, (a) => storeClaudeAuthorization(secrets, a))`.
   *
   * Errors are those of `ClaudeLoginSessions` and of
   * `storeClaudeAuthorization`, as their `ContractError`s. Before `activate`,
   * both methods fail `unavailable` ("The Claude sign-in is not ready.").
   */
  readonly implementation: ServiceImpl<typeof LoginService>;
  /** Binds the `secrets/v1` client; makes no call. */
  activate(context: Pick<HostContext, 'services'>): void;
  /** Cancels a waiting sign-in (its callback server closes). */
  deactivate(): void;
}

export const createClaudeLoginService = (
  options: ClaudeLoginServiceOptions = {},
): ClaudeLoginServiceHandle => {
  const sessions = createLoginSessions(options.deps);
  let secrets: Client<typeof SecretsService> | undefined;

  /** The `secrets/v1` client `activate` bound, or `unavailable` before it. */
  const activated = (): Client<typeof SecretsService> => {
    if (secrets === undefined) {
      throw new ContractError(
        'unavailable',
        'The Claude sign-in is not ready.',
      );
    }
    return secrets;
  };

  return {
    implementation: {
      start: async (_request, context) => {
        activated();
        return await sessions.start(context.signal);
      },
      finish: async (_request, context) => {
        const client = activated();
        const credentialDescription = await sessions.finish(
          context.signal,
          (authorization) => storeClaudeAuthorization(client, authorization),
        );
        return { credentialDescription };
      },
    },
    activate: (context) => {
      secrets = context.services.use(SecretsService);
    },
    deactivate: () => sessions.cancel(),
  };
};
