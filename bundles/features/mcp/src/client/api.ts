// The MCP part's host adapter: the only code that calls `mcp/v1`,
// `secrets/v1` and `doric.browser/v1`. Every `mcp/v1` call is bound to the
// scope of the Project it is about (`services.use(McpV1, { projectId })`),
// which is what the host reads; a call is never made without one.
//
// The watch follows one Project's servers. Every (re)subscribe delivers the
// whole list, which replaces the pane's rows. A dropped connection
// (`disconnected`, `unavailable`) or a lost host generation
// (`generation_lost`) reports nothing and subscribes again, as the layout's
// Project watch does: when the connection reports `connected`, or after one
// second when it never went down. Any other failure ends the watch with
// `mcpWatchFailed`.

import {
  type CredentialDescription,
  type Disposable,
  DoricBrowserV1,
  DoricConnectionV1,
  isContractError,
  SecretsV1,
  type Services,
  type StreamObserver,
} from 'bundle/contracts';

import {
  type McpServerInput,
  type McpServerView,
  McpV1,
} from '../contracts/index.js';

/** The message a watch that failed for good shows in the pane. */
const mcpWatchFailed = "The Project's MCP servers could not be read.";

/** The text a failed call shows: the host's own message, or the generic one. */
export const failureMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The operation could not be completed.';

/** The delay before subscribing again while the connection stays up. */
const resubscribeDelayMs = 1000;

/** The credential kind a server's own sign-in stores; never offered for an entry. */
const MCP_TOKEN_KIND = 'MCP_TOKEN';

/** The credential kind a token typed in the server dialog is stored as. */
const API_TOKEN_KIND = 'API_TOKEN';

interface McpWatchHandlers {
  /** The Project's servers, after every change. */
  readonly servers: (servers: readonly McpServerView[]) => void;
  /** The watch stopped for good, with the message the pane shows. */
  readonly failed: (message: string) => void;
}

export interface McpApi {
  create(projectId: string, input: McpServerInput): Promise<McpServerView>;
  update(
    projectId: string,
    id: string,
    input: McpServerInput,
  ): Promise<McpServerView>;
  remove(projectId: string, id: string): Promise<void>;
  /** Prepares a browser sign-in and answers the authorization URL to open. */
  signIn(projectId: string, id: string): Promise<string>;
  /** Waits for the browser's answer and answers the signed-in server. */
  finishSignIn(projectId: string, id: string): Promise<McpServerView>;
  /** Opens an https page in the system browser, outside the app. */
  openBrowser(url: string): Promise<void>;
  /** The stored credentials an entry may name, without a sign-in's own tokens. */
  credentials(): Promise<readonly CredentialDescription[]>;
  /** Stores a token under `name` and answers its description. */
  createCredential(input: {
    readonly name: string;
    readonly secret: string;
  }): Promise<CredentialDescription>;
  /** Follows the servers of `projectId` until the answer is disposed. */
  watch(projectId: string, handlers: McpWatchHandlers): Disposable;
}

/** A stream that ended this way comes back by subscribing again. */
const recoverable = (error: unknown): boolean =>
  isContractError(error) &&
  ['disconnected', 'unavailable', 'generation_lost'].includes(error.code);

export const createMcpApi = (services: Services): McpApi => {
  const mcp = (projectId: string) => services.use(McpV1, { projectId });

  const watch = (projectId: string, handlers: McpWatchHandlers): Disposable => {
    let active = true;
    let stream: Disposable | undefined;
    let waiting: Disposable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearWaits = (): void => {
      waiting?.dispose();
      waiting = undefined;
      clearTimeout(timer);
      timer = undefined;
    };

    const subscribe = (): void => {
      clearWaits();
      if (!active) return;
      let ended = false;

      const end = (error: unknown): void => {
        if (!active || ended) return;
        ended = true;
        stream = undefined;
        if (recoverable(error)) waitForConnection();
        else if (error !== undefined) handlers.failed(mcpWatchFailed);
      };
      const observer: StreamObserver<readonly McpServerView[]> = {
        next: (servers) => {
          if (active && !ended) handlers.servers(servers);
        },
        end,
      };

      try {
        const opened = mcp(projectId).watch(observer);
        if (ended || !active) opened.dispose();
        else stream = opened;
      } catch (error) {
        end(error);
      }
    };

    const waitForConnection = (): void => {
      clearWaits();
      waiting = services.whenAvailable(DoricConnectionV1, (connection) => {
        const changes = connection.subscribe((status) => {
          if (status === 'connected') subscribe();
        });
        if (connection.status() === 'connected') {
          timer = setTimeout(subscribe, resubscribeDelayMs);
        }
        return () => changes.dispose();
      });
    };

    subscribe();

    return {
      dispose: () => {
        if (!active) return;
        active = false;
        clearWaits();
        stream?.dispose();
        stream = undefined;
      },
    };
  };

  return {
    create: (projectId, input) => mcp(projectId).create(input),
    update: (projectId, id, input) => mcp(projectId).update({ ...input, id }),
    remove: (projectId, id) => mcp(projectId).remove({ id }),
    signIn: async (projectId, id) => (await mcp(projectId).signIn({ id })).url,
    finishSignIn: (projectId, id) => mcp(projectId).finishSignIn({ id }),
    openBrowser: (url) => services.use(DoricBrowserV1).open(url),
    credentials: async () =>
      (await services.use(SecretsV1).list()).filter(
        (credential) => credential.kind !== MCP_TOKEN_KIND,
      ),
    createCredential: ({ name, secret }) =>
      services.use(SecretsV1).create({ kind: API_TOKEN_KIND, name, secret }),
    watch,
  };
};
