// The sign-in calls the claude-login element makes, over the services of the
// activation that created it: `claude.login/v1` prepares and finishes the
// sign-in on the host, and `doric.browser/v1` opens the authorization page in
// the system browser, because the host may run where no browser does.

import {
  type CallArg,
  DoricBrowserV1,
  isContractError,
  type Services,
} from 'bundle/contracts';
import { ClientError } from 'desktop/reads';

import {
  ClaudeLoginV1,
  type CredentialDescription,
} from '../contracts/index.js';

/** The sign-in calls the element makes, over one activation's services. */
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
 * Throws what a refused sign-in call shows (error-messages.md §6.4): a
 * contract error keeps its own message, and its code with the error as cause
 * unless the code is `internal`; anything else is `internal` with the generic
 * message. Never returns.
 */
const failure = (error: unknown): never => {
  if (!isContractError(error))
    throw new ClientError('internal', internalMessage);
  if (error.code === 'internal')
    throw new ClientError('internal', error.message);
  throw new ClientError(error.code, error.message, { cause: error });
};

/**
 * Rejections are `ClientError`s: a `ContractError` not `internal` keeps its code
 * and message with the error as `cause`; an `internal` one is `internal` with
 * its message; anything else is `internal`, "The request could not be completed.".
 */
export const createClaudeLoginApi = (services: Services): ClaudeLoginApi => ({
  start: async (options) => {
    // A tuple method takes the call as its only argument, so an absent call
    // is no argument at all: `undefined` would be read as an input item.
    const login = services.use(ClaudeLoginV1);
    try {
      const started = await (options === undefined
        ? login.start()
        : login.start(options));
      return started.url;
    } catch (error) {
      return failure(error);
    }
  },
  finish: async (options) => {
    const login = services.use(ClaudeLoginV1);
    try {
      return await (options === undefined
        ? login.finish()
        : login.finish(options));
    } catch (error) {
      return failure(error);
    }
  },
  openBrowser: async (url) => {
    await services.use(DoricBrowserV1).open(url);
  },
});
