// The sign-in calls the claude-login element makes, over the element's
// services (a child scope that ends when the element is released):
// `claude.login/v1` prepares and finishes the sign-in on the host over its
// generated `LoginService` client (slice S65c), and `doric.browser/v1` opens
// the authorization page in the system browser, because the host may run
// where no browser does; that contract stays on the envelope.

import { ConnectError } from '@connectrpc/connect';
import {
  type CallArg,
  type ClientServices,
  ContractError,
  contractErrorDomain,
  credentialDescriptionSchema,
  DoricBrowserV1,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import { ErrorInfoSchema } from 'bundle/contracts/gen/google/rpc/error_details_pb.js';
import { ClientError } from 'desktop/reads';

import {
  type FinishResponse,
  LoginService,
} from '../contracts/gen/doric/claude/login/v1/login_pb.js';
import type { CredentialDescription } from '../contracts/index.js';

/** The sign-in calls the element makes, over one element's services. */
export interface ClaudeLoginApi {
  /** Prepares a browser sign-in and answers the authorization URL. */
  start(options?: CallArg): Promise<string>;
  /** Waits for the browser's answer and answers the stored credential's public view. */
  finish(options?: CallArg): Promise<CredentialDescription>;
  /** Opens an https page in the system browser (`doric.browser/v1`). */
  openBrowser(url: string): Promise<void>;
}

// The transport's final error handler.
const internalMessage = 'The request could not be completed.';

/**
 * Throws what a refused sign-in call shows (error-messages.md §6.4): a Doric
 * error — a `ConnectError` with a Doric `ErrorInfo` detail, as
 * `fromConnectError` reads it — keeps its own message, and its code with the
 * error as cause unless the code is `internal`; anything else — a
 * `ConnectError` without one included — is `internal` with the generic
 * message. Never returns.
 */
const failure = (failed: unknown): never => {
  const error =
    failed instanceof ConnectError &&
    failed
      .findDetails(ErrorInfoSchema)
      .some((info) => info.domain === contractErrorDomain)
      ? fromConnectError(failed)
      : failed;
  if (!isContractError(error))
    throw new ClientError('internal', internalMessage);
  if (error.code === 'internal')
    throw new ClientError('internal', error.message);
  throw new ClientError(error.code, error.message, { cause: error });
};

/** The Connect call options of a `CallArg`: its signal. */
const callOptions = (options: CallArg | undefined) =>
  options === undefined ? undefined : { signal: options.signal };

/** `Finish`'s credential as the public view; `invalid_output` outside it. */
const credentialOf = (response: FinishResponse): CredentialDescription => {
  const description = response.credentialDescription;
  const parsed = credentialDescriptionSchema.safeParse(
    description === undefined
      ? undefined
      : {
          id: description.id,
          kind: description.kind,
          name: description.name,
          ...(description.username === undefined
            ? {}
            : { username: description.username }),
          ...(description.email === undefined
            ? {}
            : { email: description.email }),
          hasSecret: description.hasSecret,
        },
  );
  if (!parsed.success)
    throw new ContractError(
      'invalid_output',
      'claude.login/v1 finish answered outside its schema.',
    );
  return parsed.data;
};

/**
 * Rejections are `ClientError`s: a Doric error not `internal` keeps its code
 * and message with the error as `cause`; an `internal` one is `internal` with
 * its message; anything else — a `ConnectError` without a Doric error
 * included — is `internal`, "The request could not be completed.".
 */
export const createClaudeLoginApi = (
  services: ClientServices,
): ClaudeLoginApi => ({
  start: async (options) => {
    try {
      const started = await services
        .use(LoginService)
        .start({}, callOptions(options));
      return started.url;
    } catch (error) {
      return failure(error);
    }
  },
  finish: async (options) => {
    try {
      return credentialOf(
        await services.use(LoginService).finish({}, callOptions(options)),
      );
    } catch (error) {
      return failure(error);
    }
  },
  openBrowser: async (url) => {
    await services.use(DoricBrowserV1).open(url);
  },
});
