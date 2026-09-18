import { spawn as nodeSpawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { OAuthErrorObject } from './classes/oauth-error.js';
import type { OAuthCallback, OAuthCallbackServer } from './types/oauth.js';

export type LocalCallbackServer = OAuthCallbackServer & {
  readonly redirectUri: string;
  close(): Promise<void>;
};

export type LocalCallbackServerOptions = {
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
};

export type BrowserProcess = {
  unref?(): void;
};

export type BrowserSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly detached: true;
    readonly stdio: 'ignore';
  },
) => BrowserProcess;

export type BrowserOpenOptions = {
  readonly platform?: NodeJS.Platform | string;
  readonly spawn?: BrowserSpawn;
};

type PendingCallback = {
  readonly expectedState: string;
  readonly resolve: (callback: OAuthCallback) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PATH = '/callback';
const DEFAULT_SUCCESS_HTML =
  '<!doctype html><title>OAuth complete</title><p>You can close this window.</p>';
const DEFAULT_ERROR_HTML =
  '<!doctype html><title>OAuth failed</title><p>OAuth did not complete.</p>';

const TEXT_HEADERS = {
  'content-type': 'text/plain',
  connection: 'close',
};

const HTML_HEADERS = {
  'content-type': 'text/html',
  connection: 'close',
};

/** Starts an explicit localhost callback server for authorization-code flows. */
export const createLocalCallbackServer = async (
  options: LocalCallbackServerOptions = {},
): Promise<LocalCallbackServer> => {
  const host = options.host ?? DEFAULT_HOST;
  const path = options.path ?? DEFAULT_PATH;
  let pending: PendingCallback | undefined;
  let closed = false;

  const server = createServer((request, response) => {
    const callback = parseCallback(request, host);

    if (callback.path !== path) {
      response.writeHead(404, TEXT_HEADERS);

      response.end('Not found');

      return;
    }

    if (pending === undefined) {
      response.writeHead(409, TEXT_HEADERS);

      response.end('No OAuth callback is pending.');

      return;
    }

    const current = pending;

    pending = undefined;

    const stateMatches = callback.value.state === current.expectedState;
    const hasError = callback.value.error !== undefined || !stateMatches;

    response.writeHead(hasError ? 400 : 200, HTML_HEADERS);

    response.end(hasError ? DEFAULT_ERROR_HTML : DEFAULT_SUCCESS_HTML);

    finishPending(current, () => current.resolve(callback.value));
  });

  await listen(server, options.port ?? 0, host);

  const address = server.address();

  if (!isAddressInfo(address)) {
    throw new OAuthErrorObject({
      code: 'oauth_callback_server_unavailable',
      message: 'OAuth callback server did not expose a TCP address.',
    });
  }

  return {
    redirectUri: `http://${host}:${address.port}${path}`,

    waitForCallback(
      expectedState: string,
      signal?: AbortSignal,
    ): Promise<OAuthCallback> {
      if (closed) {
        return Promise.reject(serverError('oauth_callback_server_closed'));
      }

      if (pending !== undefined) {
        return Promise.reject(serverError('oauth_callback_already_pending'));
      }

      return new Promise((resolve, reject) => {
        const abort = (): void => {
          if (pending !== undefined) {
            const current = pending;

            pending = undefined;

            finishPending(current, () =>
              reject(serverError('oauth_callback_aborted')),
            );
          }
        };

        pending = { expectedState, resolve, reject, signal, abort };

        if (signal?.aborted === true) {
          abort();

          return;
        }

        signal?.addEventListener('abort', abort, { once: true });
      });
    },

    async close(): Promise<void> {
      closed = true;

      if (pending !== undefined) {
        const current = pending;

        pending = undefined;

        finishPending(current, () =>
          current.reject(serverError('oauth_callback_server_closed')),
        );
      }

      await close(server);
    },
  };
};

/** Opens a URL in the platform browser through an explicit spawn boundary. */
export const openBrowser = async (
  url: string,
  options: BrowserOpenOptions = {},
): Promise<void> => {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultSpawn;
  const command = commandFor(platform, url);

  const child = spawn(command.command, command.args, {
    detached: true,
    stdio: 'ignore',
  });

  child.unref?.();
};

const parseCallback = (
  request: IncomingMessage,
  host: string,
): { readonly path: string; readonly value: OAuthCallback } => {
  const url = new URL(request.url ?? '/', `http://${host}`);

  return {
    path: url.pathname,
    value: {
      code: value(url, 'code'),
      state: value(url, 'state'),
      error: value(url, 'error'),
      errorDescription: value(url, 'error_description'),
    },
  };
};

const value = (url: URL, key: string): string | undefined =>
  url.searchParams.get(key) ?? undefined;

const listen = (server: Server, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen(port, host, () => {
      server.off('error', reject);

      resolve();
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    const connections = server as Server & {
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };

    const forceClose = setTimeout(() => {
      connections.closeAllConnections?.();
    }, 100);

    server.close((error) => {
      clearTimeout(forceClose);

      if (error === undefined) {
        resolve();

        return;
      }

      reject(error);
    });

    connections.closeIdleConnections?.();
  });

const finishPending = (
  pending: PendingCallback,
  complete: () => void,
): void => {
  pending.signal?.removeEventListener('abort', pending.abort);

  complete();
};

const isAddressInfo = (
  value: string | AddressInfo | null,
): value is AddressInfo => value !== null && typeof value !== 'string';

const serverError = (code: string): OAuthErrorObject =>
  new OAuthErrorObject({
    code,
    message: code.replaceAll('_', ' '),
  });

const commandFor = (
  platform: string,
  url: string,
): { readonly command: string; readonly args: readonly string[] } => {
  if (platform === 'win32') {
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  }

  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }

  return { command: 'xdg-open', args: [url] };
};

const defaultSpawn: BrowserSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], options);
