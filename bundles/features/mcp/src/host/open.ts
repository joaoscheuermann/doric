// How a client reaches one server. An `http` server is reached from the
// host: Streamable HTTP first, then, when that fails for another reason than
// authorization, HTTP+SSE with a new client. A `stdio` server runs only in
// the Project's sandbox, started through runtime.lease/v1 on the sandbox the
// Project holds now; it is never a host process. Either one receives the
// server's own resolved entries and nothing else.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RuntimeLease } from 'runtime/contracts';

import type { McpTransport } from '../contracts/index.js';
import type { ResolvedEntries } from './credentials.js';
import { SignInRequired } from './oauth.js';
import { SKILLS_EXTENSION } from './skills.js';
import { createSandboxStdioTransport } from './stdio.js';

const CLIENT_INFO = { name: 'doric', version: '1.0.0' };

/** A client connected to its server, or a sandbox that is not up yet. */
export type Opened =
  | { readonly kind: 'open'; readonly client: Client }
  | { readonly kind: 'waiting' };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/** Whether a failure is the server asking for a sign-in, not a transport one. */
export const isAuthFailure = (error: unknown): boolean =>
  error instanceof SignInRequired ||
  error instanceof UnauthorizedError ||
  (error instanceof StreamableHTTPError &&
    (error.code === 401 || error.code === 403));

/**
 * A new client connected over `transport`. A failed connection is closed: a
 * transport whose `start` failed (an SSE stream that keeps reconnecting) is
 * not closed by the SDK.
 */
const connect = async (
  transport: Transport,
  signal: AbortSignal,
): Promise<Client> => {
  const client = new Client(CLIENT_INFO, {
    capabilities: { extensions: { [SKILLS_EXTENSION]: {} } },
  });

  try {
    await client.connect(transport, { signal });
  } catch (error) {
    // The connection's failure is what the server's status reports; a failure
    // to close what never connected adds nothing to it.
    await client.close().catch(() => undefined);
    throw error;
  }

  return client;
};

/** Connects to an `http` server with its headers and its background OAuth provider. */
export const openHttp = async (
  url: URL,
  entries: ResolvedEntries,
  authProvider: OAuthClientProvider,
  signal: AbortSignal,
): Promise<Opened> => {
  const options = { requestInit: { headers: entries.values }, authProvider };

  let streamable: unknown;

  try {
    return {
      kind: 'open',
      client: await connect(
        new StreamableHTTPClientTransport(url, options),
        signal,
      ),
    };
  } catch (error) {
    if (signal.aborted || isAuthFailure(error)) throw error;
    streamable = error;
  }

  // A server that predates Streamable HTTP speaks HTTP+SSE.
  try {
    return {
      kind: 'open',
      client: await connect(new SSEClientTransport(url, options), signal),
    };
  } catch (error) {
    if (signal.aborted || isAuthFailure(error)) throw error;
    // Most servers speak Streamable HTTP: its failure says why, the
    // fallback's follows it.
    throw new Error(
      `${messageOf(streamable)} (over HTTP+SSE: ${messageOf(error)})`,
      { cause: streamable },
    );
  }
};

/**
 * Starts a `stdio` server in the Project's sandbox, with its own entries
 * added to the sandbox's environment, and connects to it. `waiting` when the
 * Project holds no sandbox lease yet, or lost it while the server started
 * (that client is closed, so its process ends); rejects when the Project is
 * gone or has ended, or when the sandbox cannot keep a process running.
 */
export const openStdio = async (
  transport: Extract<McpTransport, { readonly kind: 'stdio' }>,
  entries: ResolvedEntries,
  lease: Pick<RuntimeLease, 'withLease'>,
  onStderr: (line: string) => void,
  signal: AbortSignal,
): Promise<Opened> => {
  const { command, args, cwd } = transport;
  const env = Object.entries(entries.values).map(
    ([name, value]) => `${name}=${value}`,
  );
  // What the task connected, whatever the lease answers after it.
  const task: { client?: Client } = {};
  const outcome = await lease.withLease(async (sandbox) => {
    const start = sandbox.start?.bind(sandbox);

    if (start === undefined) {
      throw new Error(
        'The Project sandbox cannot keep a process running, so it cannot run a stdio MCP server.',
      );
    }

    task.client = await connect(
      createSandboxStdioTransport({
        start: (onOutput) =>
          start({
            cmd: [command, ...args],
            ...(cwd === undefined ? {} : { cwd }),
            env,
            tty: false,
            onOutput,
          }),
        secrets: entries.secrets,
        onStderr,
      }),
      signal,
    );

    return task.client;
  });

  if (outcome.status === 'ready')
    return { kind: 'open', client: outcome.value };
  // The lease dropped while the server started: its process must not outlive it.
  await task.client?.close().catch(() => undefined);

  if (outcome.status === 'missing') {
    throw new Error(
      'The Project no longer exists, so its stdio MCP server cannot start.',
    );
  }

  if (outcome.status === 'expired') {
    throw new Error(
      'The Project has ended, so its sandbox cannot run a stdio MCP server.',
    );
  }

  return { kind: 'waiting' };
};
