// The MCP part's host adapter: the only code that calls `mcp/v1`,
// `secrets/v1` and `doric.browser/v1`. From slice S65c `mcp/v1` and
// `secrets/v1` are their generated `McpService` and `SecretsService` clients
// over Connect, and a failure is its Doric error (`fromConnectError`);
// `doric.browser/v1` stays on the envelope. Every `mcp/v1` call is bound to
// the scope of the Project it is about (`services.use(McpService,
// { projectId })`), which is what the host reads; a call is never made
// without one.
//
// The watch follows one Project's servers. Every (re)subscribe delivers the
// whole list, which replaces the pane's rows. `Watch` is resumable, so the
// SDK reopens it after a lost host generation. A dropped connection
// (`disconnected`, `unavailable`) reports nothing and subscribes again, as
// the layout's Project watch does: when the connection reports `connected`,
// or after one second when it never went down. Any other failure ends the
// watch with `mcpWatchFailed`.

import { ConnectError } from '@connectrpc/connect';
import {
  type ClientServices,
  type CredentialDescription,
  type Disposable,
  DoricBrowserV1,
  DoricConnectionV1,
  fromConnectError,
  isContractError,
  type Services,
} from 'bundle/contracts';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';

import { McpService } from '../contracts/gen/doric/mcp/v1/mcp_pb.js';
import type { McpServerInput, McpServerView } from '../contracts/index.js';
import { credentialOf, serverInputMessageOf, serverViewOf } from './codec.js';

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

/** A Connect failure as its Doric error (`fromConnectError`); any other error unchanged. */
const contractError = (error: unknown): unknown =>
  error instanceof ConnectError ? fromConnectError(error) : error;

/** Runs a host call; a failure is thrown as its Doric error. */
const reach = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    throw contractError(error);
  }
};

/** A stream that ended this way comes back by subscribing again. */
const recoverable = (error: unknown): boolean =>
  isContractError(error) &&
  ['disconnected', 'unavailable'].includes(error.code);

export const createMcpApi = (services: Services): McpApi => {
  const client = services as ClientServices;
  const mcp = (projectId: string) => client.use(McpService, { projectId });

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
      const controller = new AbortController();

      const end = (error: unknown): void => {
        if (!active || ended) return;
        ended = true;
        stream = undefined;
        if (recoverable(error)) waitForConnection();
        else if (error !== undefined) handlers.failed(mcpWatchFailed);
      };

      stream = { dispose: () => controller.abort() };
      void (async () => {
        try {
          for await (const { servers } of mcp(projectId).watch(
            {},
            { signal: controller.signal },
          )) {
            if (!active || ended) return;
            handlers.servers(servers.map(serverViewOf));
          }
          end(undefined);
        } catch (error) {
          if (controller.signal.aborted) return;
          end(contractError(error));
        }
      })();
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
    create: (projectId, input) =>
      reach(async () =>
        serverViewOf(
          (
            await mcp(projectId).create({
              mcpServerInput: serverInputMessageOf(input),
            })
          ).mcpServerView,
        ),
      ),
    update: (projectId, id, input) =>
      reach(async () =>
        serverViewOf(
          (
            await mcp(projectId).update({
              id,
              mcpServerInput: serverInputMessageOf(input),
            })
          ).mcpServerView,
        ),
      ),
    remove: (projectId, id) =>
      reach(async () => {
        await mcp(projectId).remove({ id });
      }),
    signIn: (projectId, id) =>
      reach(async () => (await mcp(projectId).signIn({ id })).url),
    finishSignIn: (projectId, id) =>
      reach(async () =>
        serverViewOf((await mcp(projectId).finishSignIn({ id })).mcpServerView),
      ),
    openBrowser: (url) => services.use(DoricBrowserV1).open(url),
    credentials: () =>
      reach(async () =>
        (await client.use(SecretsService).list({})).credentials
          .map(credentialOf)
          .filter((credential) => credential.kind !== MCP_TOKEN_KIND),
      ),
    createCredential: ({ name, secret }) =>
      reach(async () =>
        credentialOf(
          (
            await client
              .use(SecretsService)
              .create({ kind: API_TOKEN_KIND, name, secret })
          ).credentialDescription,
        ),
      ),
    watch,
  };
};
