// The live side of the servers: at most one connection per server, its tools
// registered with tools/v1 under the server's Project while it is connected
// and unregistered whenever it leaves that state, and every state change
// published to the Project's watchers. Every message about a server masks
// the secrets its entries resolved to.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolResultSchema,
  type Tool,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type Disposable,
  LogV1,
  SecretsV1,
  type Services,
  ToolsV1,
} from 'bundle/contracts';
import { RuntimeLeaseV1 } from 'runtime/contracts';
import { ToolErrorObject } from 'tool';

import type {
  McpServerView,
  McpStatus,
  McpToolView,
} from '../contracts/index.js';
import {
  type OAuthVault,
  type ResolvedEntries,
  redact,
  resolveEntries,
} from './credentials.js';
import { createOAuthProvider } from './oauth.js';
import { isAuthFailure, type Opened, openHttp, openStdio } from './open.js';
import type { ServerDocument, ServerStore } from './store.js';
import {
  listTools,
  serverSlug,
  toDoricTool,
  toolName,
  toolView,
} from './tools.js';

interface ManagerOptions {
  readonly services: Services;
  readonly store: ServerStore;
  readonly vault: OAuthVault;
}

/** The servers' connections and the views their Projects watch. */
export interface McpManager {
  /** Connects every enabled server of the Project not connected yet; resolves once each attempt ended. */
  ensureProject(projectId: string): Promise<void>;
  /**
   * Applies a stored server's new configuration: stops it when disabled,
   * reconnects it when it was live or its Project is watched.
   */
  reconcile(server: ServerDocument): Promise<void>;
  /** (Re)connects the stored server; resolves once the attempt ended. */
  connect(serverId: string): Promise<void>;
  /** Closes the server's connection and unregisters its tools; it reads as idle again. */
  stop(serverId: string): Promise<void>;
  stopProject(projectId: string): Promise<void>;
  /** Sends the Project's watchers its servers as they are now. */
  publish(projectId: string): void;
  viewOf(server: ServerDocument): McpServerView;
  snapshot(projectId: string): Promise<readonly McpServerView[]>;
  /** Delivers the Project's servers now, then after every change. */
  subscribe(
    projectId: string,
    listener: (servers: readonly McpServerView[]) => void,
  ): Disposable;
  /** Stops every server; nothing connects any more. */
  dispose(): Promise<void>;
}

/** How long one tool call may take on its server. */
const TOOL_TIMEOUT_MS = 300_000;
/** After every built-in tool (the last one is `git`, at 900). */
const TOOL_ORDER = 1000;
/** How many of a process's last stderr lines a failure keeps. */
const STDERR_LINES = 5;

/** One open connection and what it registered. */
interface Connection {
  readonly client: Client;
  /** Masked in every message about it. */
  readonly secrets: readonly string[];
  registrations: readonly Disposable[];
  /** Whether it is closing, so its close notice is no failure. */
  closing: boolean;
  /** The tool listings, one after the other. */
  listing: Promise<void>;
}

/** A server's live state, while it is connecting, connected or failed. */
interface Live {
  readonly projectId: string;
  status: { readonly state: McpStatus; readonly message?: string };
  tools: readonly McpToolView[];
  attempt?: {
    readonly controller: AbortController;
    readonly done: Promise<void>;
  };
  connection?: Connection;
  /** The last stderr lines of a stdio server's process, masked. */
  readonly stderr: string[];
}

type Listener = (servers: readonly McpServerView[]) => void;

const messageOf = (error: unknown, secrets: readonly string[]): string =>
  redact(
    error instanceof Error ? error.message || error.name : String(error),
    secrets,
  );

export const createManager = ({
  services,
  store,
  vault,
}: ManagerOptions): McpManager => {
  const live = new Map<string, Live>();
  const watchers = new Map<string, Set<Listener>>();
  const deliveries = new Map<string, Promise<void>>();
  let disposed = false;

  const log = () => services.use(LogV1);

  const viewOf = (server: ServerDocument): McpServerView => {
    const entry = server.enabled ? live.get(server.id) : undefined;
    const status: McpServerView['status'] = server.enabled
      ? (entry?.status ?? { state: 'idle' })
      : { state: 'disabled' };

    return {
      id: server.id,
      projectId: server.projectId,
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      status,
      signedIn:
        server.transport.kind === 'http' &&
        server.oauth?.accessCredentialId !== undefined,
      tools: status.state === 'connected' ? (entry?.tools ?? []) : [],
    };
  };

  const snapshot = async (projectId: string) =>
    (await store.list(projectId)).map(viewOf);

  /** Delivers one Project's snapshots in order, so a later state never arrives first. */
  const deliver = (
    projectId: string,
    listeners: () => Iterable<Listener>,
  ): void => {
    const next = (deliveries.get(projectId) ?? Promise.resolve())
      .then(async () => {
        const servers = await snapshot(projectId);

        for (const listener of [...listeners()]) {
          try {
            listener(servers);
          } catch (error) {
            log().warn('An MCP watcher failed', {
              error: messageOf(error, []),
            });
          }
        }
      })
      .catch((error: unknown) => {
        log().warn('The MCP servers could not be read for their watchers', {
          projectId,
          error: messageOf(error, []),
        });
      });
    deliveries.set(projectId, next);
  };

  const publish = (projectId: string): void => {
    if ((watchers.get(projectId)?.size ?? 0) === 0) return;
    deliver(projectId, () => watchers.get(projectId) ?? []);
  };

  const unregister = (connection: Connection): void => {
    for (const registration of connection.registrations) {
      registration.dispose();
    }
    connection.registrations = [];
  };

  /** Closes a connection this side ends; a failure to close is logged. */
  const release = async (connection: Connection): Promise<void> => {
    connection.closing = true;
    unregister(connection);
    await connection.client.close().catch((error: unknown) => {
      log().warn('An MCP connection did not close', {
        error: messageOf(error, connection.secrets),
      });
    });
  };

  /** Registers the server's tools; answers the views of those it registered. */
  const register = (
    server: ServerDocument,
    connection: Connection,
    tools: readonly Tool[],
  ): readonly McpToolView[] => {
    const slug = serverSlug(server.name);
    const taken = new Set<string>();
    const views: McpToolView[] = [];
    const registrations: Disposable[] = [];
    const { client } = connection;

    try {
      for (const tool of tools) {
        const name = toolName(slug, tool.name, taken);
        taken.add(name);

        try {
          const definition = toDoricTool({
            name,
            tool,
            callTool: async (request, signal) =>
              CallToolResultSchema.parse(
                await client.callTool(
                  { name: request.name, arguments: { ...request.arguments } },
                  CallToolResultSchema,
                  { signal, timeout: TOOL_TIMEOUT_MS },
                ),
              ),
          });
          registrations.push(
            services.use(ToolsV1).register(definition, {
              alwaysAvailable: false,
              order: TOOL_ORDER,
              projectId: server.projectId,
            }),
          );
          views.push(toolView(tool));
        } catch (error) {
          // One tool with an unusable schema leaves the others usable.
          if (!(error instanceof ToolErrorObject)) throw error;
          log().warn('An MCP tool was skipped', {
            serverId: server.id,
            tool: tool.name,
            error: error.message,
          });
        }
      }
    } catch (error) {
      for (const registration of registrations) registration.dispose();
      throw error;
    }

    connection.registrations = registrations;

    return views;
  };

  /** Lists the tools and replaces the registrations, after any listing in progress. */
  const refresh = (
    server: ServerDocument,
    entry: Live,
    connection: Connection,
    signal?: AbortSignal,
  ): Promise<void> => {
    const run = connection.listing.then(async () => {
      const tools = await listTools(connection.client, signal);
      if (connection.closing) return;
      unregister(connection);
      entry.tools = register(server, connection, tools);
    });
    // The chain only orders the listings; each caller handles its own failure.
    connection.listing = run.catch(() => undefined);

    return run;
  };

  /** The server ended the connection on its own (a process that exited). */
  const closed = (entry: Live, connection: Connection): void => {
    if (connection.closing || entry.connection !== connection) return;
    connection.closing = true;
    unregister(connection);
    entry.connection = undefined;
    entry.tools = [];
    const last = entry.stderr.at(-1);
    entry.status = {
      state: 'error',
      message: `The MCP server closed the connection${last === undefined ? '.' : `: ${last}`}`,
    };
    publish(entry.projectId);
  };

  const open = (
    server: ServerDocument,
    entry: Live,
    entries: ResolvedEntries,
    signal: AbortSignal,
  ): Promise<Opened> => {
    const { transport } = server;

    if (transport.kind === 'stdio') {
      return openStdio(
        transport,
        entries,
        services.use(RuntimeLeaseV1, { projectId: server.projectId }),
        (line) => {
          entry.stderr.push(line);
          entry.stderr.splice(0, entry.stderr.length - STDERR_LINES);
        },
        signal,
      );
    }

    const authProvider = createOAuthProvider({
      serverId: server.id,
      mode: 'background',
      load: () => vault.load(server.id),
      save: (patch) => vault.save(server.id, patch),
      invalidate: (scope) => vault.invalidate(server.id, scope),
    });

    return openHttp(new URL(transport.url), entries, authProvider, signal);
  };

  const attempt = async (
    server: ServerDocument,
    entry: Live,
    controller: AbortController,
  ): Promise<void> => {
    const { signal } = controller;
    const current = () => !signal.aborted && live.get(server.id) === entry;
    const { transport } = server;
    let secrets: readonly string[] = [];

    try {
      const entries = await resolveEntries(
        transport.kind === 'http' ? transport.headers : transport.env,
        services.use(SecretsV1),
      );
      secrets = entries.secrets;
      const opened = await open(server, entry, entries, signal);

      if (opened.kind === 'waiting') {
        if (current()) entry.status = { state: 'waiting-for-sandbox' };
        return;
      }

      const connection: Connection = {
        client: opened.client,
        secrets,
        registrations: [],
        closing: false,
        listing: Promise.resolve(),
      };

      if (!current()) {
        await release(connection);
        return;
      }

      entry.connection = connection;
      opened.client.onclose = () => closed(entry, connection);
      opened.client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        () =>
          refresh(server, entry, connection).then(
            () => publish(server.projectId),
            (error: unknown) => {
              log().warn('The MCP server tools could not be listed again', {
                serverId: server.id,
                error: messageOf(error, secrets),
              });
            },
          ),
      );
      await refresh(server, entry, connection, signal);

      if (current() && entry.connection === connection) {
        entry.status = { state: 'connected' };
      }
    } catch (error) {
      if (!current()) return;
      const { connection } = entry;
      entry.connection = undefined;
      entry.tools = [];
      entry.status = isAuthFailure(error)
        ? { state: 'needs-sign-in' }
        : { state: 'error', message: messageOf(error, secrets) };
      if (connection !== undefined) await release(connection);
    } finally {
      if (entry.attempt?.controller === controller) entry.attempt = undefined;
      if (live.get(server.id) === entry) publish(entry.projectId);
    }
  };

  /** Ends whatever the entry runs: its attempt, its connection, its tools. */
  const halt = async (entry: Live): Promise<void> => {
    entry.attempt?.controller.abort();
    const { connection } = entry;
    entry.connection = undefined;
    if (connection !== undefined) await release(connection);
    await entry.attempt?.done;
  };

  const start = (server: ServerDocument): Promise<void> => {
    const previous = live.get(server.id);
    const controller = new AbortController();
    const entry: Live = {
      projectId: server.projectId,
      status: { state: 'connecting' },
      tools: [],
      stderr: [],
    };
    live.set(server.id, entry);
    const done = (async () => {
      if (previous !== undefined) await halt(previous);
      if (!controller.signal.aborted) await attempt(server, entry, controller);
    })();
    entry.attempt = { controller, done };
    publish(server.projectId);

    return done;
  };

  const stop = async (serverId: string): Promise<void> => {
    const entry = live.get(serverId);
    if (entry === undefined) return;
    live.delete(serverId);
    await halt(entry);
    publish(entry.projectId);
  };

  return {
    ensureProject: async (projectId) => {
      const servers = await store.list(projectId);

      await Promise.all(
        servers
          .filter((server) => server.enabled && !disposed)
          .map((server) => {
            const entry = live.get(server.id);
            if (entry?.attempt !== undefined) return entry.attempt.done;
            if (entry?.status.state === 'connected') return undefined;
            return start(server);
          }),
      );
    },
    reconcile: async (server) => {
      const watched = (watchers.get(server.projectId)?.size ?? 0) > 0;

      if (server.enabled && !disposed && (live.has(server.id) || watched)) {
        return start(server);
      }

      // Disabled, or not live and not watched: nothing runs, and it shows.
      await stop(server.id);
      publish(server.projectId);
    },
    connect: async (serverId) => {
      const server = await store.get(serverId);
      if (server === undefined || disposed) return;
      await (server.enabled ? start(server) : stop(serverId));
    },
    stop,
    stopProject: async (projectId) => {
      await Promise.all(
        [...live]
          .filter(([, entry]) => entry.projectId === projectId)
          .map(([serverId]) => stop(serverId)),
      );
    },
    publish,
    viewOf,
    snapshot,
    subscribe: (projectId, listener) => {
      const listeners = watchers.get(projectId) ?? new Set();
      watchers.set(projectId, listeners);
      listeners.add(listener);
      deliver(projectId, () => (listeners.has(listener) ? [listener] : []));

      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    dispose: async () => {
      disposed = true;
      watchers.clear();
      const entries = [...live.values()];
      live.clear();
      await Promise.all(entries.map(halt));
    },
  };
};
