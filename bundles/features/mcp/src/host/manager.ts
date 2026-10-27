// The live side of the servers: at most one connection per server, its tools
// registered with tools/v1 under the server's Project while it is connected
// and unregistered whenever it leaves that state, and every state change
// published to the Project's watchers. A server waiting for its Project's
// sandbox connects when that Project is ready. Every message about a server
// masks the secrets its entries resolved to.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolResultSchema,
  McpError,
  type Tool,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type Disposable,
  HooksV1,
  LogV1,
  SecretsV1,
  type Services,
  ToolsV1,
} from 'bundle/contracts';
import { RuntimeHooksV1, RuntimeLeaseV1 } from 'runtime/contracts';

import type {
  McpServerView,
  McpSkillView,
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
import { listSkills } from './skills.js';
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
  /**
   * Connects every enabled server of the Project not connected yet, each as
   * stored when it starts; resolves once each attempt ended.
   */
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
  /** Stops the Project's servers; an `ensureProject` begun before starts none. */
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
/** How long the check of a connection whose tool call failed may take. */
const PROBE_TIMEOUT_MS = 10_000;
/** How long a registration waits for tools/v1 to drop the name it reuses. */
const RELEASE_WAIT_MS = 5_000;
const RELEASE_POLL_MS = 25;

/** One tool a connection registered. */
interface Registered {
  readonly registration: Disposable;
  /** The MCP tool it was made from: the same one keeps its registration. */
  readonly source: string;
  readonly view: McpToolView;
}

/** One open connection and what it registered. */
interface Connection {
  readonly client: Client;
  /** Masked in every message about it. */
  readonly secrets: readonly string[];
  /** Its registered tools, by Doric name. */
  readonly registered: Map<string, Registered>;
  /** Whether it is closing, so its close notice is no failure. */
  closing: boolean;
  /** Whether a failed tool call is having it checked. */
  probing: boolean;
  /** The tool listings, one after the other. */
  listing: Promise<void>;
}

/** A server's live state, while it is connecting, connected or failed. */
interface Live {
  readonly projectId: string;
  status: { readonly state: McpStatus; readonly message?: string };
  tools: readonly McpToolView[];
  skills: readonly McpSkillView[];
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const createManager = ({
  services,
  store,
  vault,
}: ManagerOptions): McpManager => {
  const live = new Map<string, Live>();
  const watchers = new Map<string, Set<Listener>>();
  const deliveries = new Map<string, Promise<void>>();
  /** How many times each Project closed: what started before stays stopped. */
  const closings = new Map<string, number>();
  /**
   * The names unregistered under each Project that tools/v1 may still list:
   * across the bundle envelope a dispose reaches the registry after it
   * returns, and registering a name still listed is refused.
   */
  const releasing = new Map<string, Set<string>>();
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
      skills: status.state === 'connected' ? (entry?.skills ?? []) : [],
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

  const unregister = (projectId: string, connection: Connection): void => {
    const names = releasing.get(projectId) ?? new Set<string>();
    releasing.set(projectId, names);

    for (const [name, { registration }] of connection.registered) {
      registration.dispose();
      names.add(name);
    }
    connection.registered.clear();
  };

  /**
   * Resolves once tools/v1 lists none of `names` the Project released, or
   * after RELEASE_WAIT_MS (a name another bundle holds stays listed).
   */
  const released = async (
    projectId: string,
    names: Iterable<string>,
  ): Promise<void> => {
    const pending = releasing.get(projectId);
    const reused = [...names].filter((name) => pending?.has(name));
    if (reused.length === 0) return;
    const deadline = Date.now() + RELEASE_WAIT_MS;
    const tools = services.use(ToolsV1, { projectId });

    for (;;) {
      // A registry that cannot be read is not waited for.
      const listed = await tools.catalog().then(
        (entries) => new Set(entries.map(({ name }) => name)),
        () => new Set<string>(),
      );
      const held = reused.filter((name) => listed.has(name));

      if (held.length === 0 || Date.now() >= deadline) {
        for (const name of reused) pending?.delete(name);
        return;
      }

      await sleep(RELEASE_POLL_MS);
    }
  };

  /** Closes a connection this side ends; a failure to close is logged. */
  const release = async (
    entry: Live,
    connection: Connection,
  ): Promise<void> => {
    connection.closing = true;
    unregister(entry.projectId, connection);
    await connection.client.close().catch((error: unknown) => {
      log().warn('An MCP connection did not close', {
        error: messageOf(error, connection.secrets),
      });
    });
  };

  /** The views of the registered tools, in the server's order. */
  const viewsOf = (
    wanted: ReadonlyMap<string, Tool>,
    registered: ReadonlyMap<string, Registered>,
  ): readonly McpToolView[] =>
    [...wanted.keys()].flatMap((name) => {
      const found = registered.get(name);
      return found === undefined ? [] : [found.view];
    });

  /** Ends a connection that no longer works: its tools go, the status says why. */
  const lose = (
    entry: Live,
    connection: Connection,
    status: Live['status'],
  ): void => {
    entry.connection = undefined;
    entry.tools = [];
    entry.status = status;
    publish(entry.projectId);
    void release(entry, connection);
  };

  /**
   * A tool call failed without an MCP answer, and the client never closes
   * on its own: the connection may be gone (a session the server no longer
   * knows, a token that no longer works, a server that went away). An
   * authorization failure leaves the server needing a sign-in; any other
   * failure a ping confirms connects it again, which ends `connected` or in
   * `error`.
   */
  const failed = (
    server: ServerDocument,
    entry: Live,
    connection: Connection,
    error: unknown,
  ): void => {
    const current = () =>
      !connection.closing &&
      entry.connection === connection &&
      live.get(server.id) === entry;

    if (error instanceof McpError || connection.probing || !current()) return;

    if (isAuthFailure(error)) {
      lose(entry, connection, { state: 'needs-sign-in' });
      return;
    }

    connection.probing = true;
    connection.client.ping({ timeout: PROBE_TIMEOUT_MS }).then(
      () => {
        connection.probing = false;
      },
      (probe: unknown) => {
        connection.probing = false;
        if (probe instanceof McpError || !current()) return;

        if (isAuthFailure(probe)) {
          lose(entry, connection, { state: 'needs-sign-in' });
          return;
        }

        connectServer(server.id).catch((reconnect: unknown) => {
          log().warn('An MCP server could not connect again', {
            serverId: server.id,
            error: messageOf(reconnect, connection.secrets),
          });
        });
      },
    );
  };

  /**
   * Registers the server's tools, keeping the registration of each tool
   * that did not change; the entry's tools are what is registered. A tool
   * whose schema is unusable or whose name tools/v1 refuses is left out.
   */
  const register = async (
    server: ServerDocument,
    entry: Live,
    connection: Connection,
    tools: readonly Tool[],
  ): Promise<void> => {
    const slug = serverSlug(server.name);
    const taken = new Set<string>();
    const wanted = new Map<string, Tool>();

    for (const tool of tools) {
      const name = toolName(slug, tool.name, taken);
      taken.add(name);
      wanted.set(name, tool);
    }

    const { registered } = connection;
    const names = releasing.get(server.projectId) ?? new Set<string>();
    releasing.set(server.projectId, names);

    // A removed or changed tool goes; an unchanged one stays registered.
    for (const [name, current] of registered) {
      const next = wanted.get(name);
      if (next !== undefined && JSON.stringify(next) === current.source) {
        continue;
      }
      current.registration.dispose();
      registered.delete(name);
      names.add(name);
    }

    try {
      await released(
        server.projectId,
        [...wanted.keys()].filter((name) => !registered.has(name)),
      );
    } finally {
      entry.tools = viewsOf(wanted, registered);
    }

    for (const [name, tool] of wanted) {
      if (connection.closing) return;
      if (registered.has(name)) continue;

      try {
        const definition = toDoricTool({
          name,
          tool,
          callTool: async (request, signal) => {
            let result: unknown;

            try {
              result = await connection.client.callTool(
                { name: request.name, arguments: { ...request.arguments } },
                CallToolResultSchema,
                { signal, timeout: TOOL_TIMEOUT_MS },
              );
            } catch (error) {
              if (!signal.aborted) failed(server, entry, connection, error);
              throw error;
            }

            return CallToolResultSchema.parse(result);
          },
        });
        registered.set(name, {
          registration: services.use(ToolsV1).register(definition, {
            alwaysAvailable: false,
            order: TOOL_ORDER,
            projectId: server.projectId,
          }),
          source: JSON.stringify(tool),
          view: toolView(tool),
        });
      } catch (error) {
        // One tool that cannot be registered leaves the others usable.
        log().warn('An MCP tool was skipped', {
          serverId: server.id,
          tool: tool.name,
          error: messageOf(error, connection.secrets),
        });
      }
    }

    entry.tools = viewsOf(wanted, registered);
  };

  /** Lists the tools and updates the registrations, after any listing in progress. */
  const refresh = (
    server: ServerDocument,
    entry: Live,
    connection: Connection,
    signal?: AbortSignal,
  ): Promise<void> => {
    const run = connection.listing.then(async () => {
      const tools = await listTools(connection.client, signal);
      if (connection.closing) return;
      await register(server, entry, connection, tools);
    });
    // The chain only orders the listings; each caller handles its own failure.
    connection.listing = run.catch(() => undefined);

    return run;
  };

  /** The server ended the connection on its own (a process that exited). */
  const closed = (entry: Live, connection: Connection): void => {
    if (connection.closing || entry.connection !== connection) return;
    connection.closing = true;
    unregister(entry.projectId, connection);
    entry.connection = undefined;
    entry.tools = [];
    entry.skills = [];
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
      serverUrl: transport.url,
      load: () => vault.load(server.id),
      save: (patch) => vault.save(server.id, patch),
      invalidate: (scope, url) => vault.invalidate(server.id, scope, url),
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
        registered: new Map(),
        closing: false,
        probing: false,
        listing: Promise.resolve(),
      };

      if (!current()) {
        await release(entry, connection);
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
      const skills = await listSkills(connection.client, signal).catch(
        (error: unknown) => {
          if (!signal.aborted) {
            log().warn('The MCP server skills could not be listed', {
              serverId: server.id,
              error: messageOf(error, secrets),
            });
          }
          return [];
        },
      );

      if (current() && entry.connection === connection) {
        entry.skills = skills;
        entry.status = { state: 'connected' };
      }
    } catch (error) {
      if (!current()) return;
      const { connection } = entry;
      entry.connection = undefined;
      entry.tools = [];
      entry.skills = [];
      entry.status = isAuthFailure(error)
        ? { state: 'needs-sign-in' }
        : { state: 'error', message: messageOf(error, secrets) };
      if (connection !== undefined) await release(entry, connection);
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
    if (connection !== undefined) await release(entry, connection);
    await entry.attempt?.done;
  };

  /** Starts the server over whatever ran it; answers the new entry and its attempt. */
  const launch = (
    server: ServerDocument,
  ): { readonly entry: Live; readonly done: Promise<void> } => {
    const previous = live.get(server.id);
    const controller = new AbortController();
    const entry: Live = {
      projectId: server.projectId,
      status: { state: 'connecting' },
      tools: [],
      skills: [],
      stderr: [],
    };
    live.set(server.id, entry);
    const done = (async () => {
      if (previous !== undefined) await halt(previous);
      if (!controller.signal.aborted) await attempt(server, entry, controller);
    })();
    entry.attempt = { controller, done };
    publish(server.projectId);

    return { entry, done };
  };

  const start = (server: ServerDocument): Promise<void> => launch(server).done;

  const stop = async (serverId: string): Promise<void> => {
    const entry = live.get(serverId);
    if (entry === undefined) return;
    live.delete(serverId);
    await halt(entry);
    publish(entry.projectId);
  };

  const connectServer = async (serverId: string): Promise<void> => {
    const server = await store.get(serverId);
    if (server === undefined || disposed) return;
    await (server.enabled ? start(server) : stop(serverId));
  };

  /**
   * Starts a server `ensureProject` listed unless it went away since: it was
   * removed, disabled or moved, its Project closed (`closing` is the count
   * the listing began with) or the manager was disposed. The check and the
   * start hold the server's lock, as its changes do; a server removed while
   * it connected is stopped once the attempt ended.
   */
  const ensure = async (
    projectId: string,
    listed: ServerDocument,
    closing: number,
  ): Promise<void> => {
    const running = live.get(listed.id);
    if (running?.attempt !== undefined) return running.attempt.done;
    if (running?.status.state === 'connected') return;

    const started = await store.lock(listed.id, async () => {
      const server = await store.get(listed.id);

      if (
        server === undefined ||
        !server.enabled ||
        server.projectId !== projectId ||
        disposed ||
        (closings.get(projectId) ?? 0) !== closing
      ) {
        return undefined;
      }

      const now = live.get(server.id);
      // Another start came first.
      if (now?.attempt !== undefined)
        return { entry: now, done: now.attempt.done };
      if (now?.status.state === 'connected') return undefined;

      return launch(server);
    });

    if (started === undefined) return;
    await started.done;
    const after = await store.get(listed.id);

    if (
      (after === undefined || !after.enabled) &&
      live.get(listed.id) === started.entry
    ) {
      await stop(listed.id);
    }
  };

  /** Connects the Project's servers that wait for its sandbox, now up. */
  const sandboxReady = async (projectId: string): Promise<void> => {
    await Promise.all(
      [...live]
        .filter(([, entry]) => entry.projectId === projectId)
        .map(async ([serverId, entry]) => {
          // An attempt in progress may be about to wait.
          await entry.attempt?.done;

          if (
            live.get(serverId) === entry &&
            entry.status.state === 'waiting-for-sandbox'
          ) {
            await connectServer(serverId);
          }
        }),
    );
  };

  const readiness = services
    .use(HooksV1)
    .whenAvailable(RuntimeHooksV1, (registrar) => {
      const ready = registrar.onProjectReadyHook(({ projectId }) =>
        sandboxReady(projectId).catch((error: unknown) => {
          log().warn(
            'The MCP servers waiting for a sandbox could not connect',
            {
              projectId,
              error: messageOf(error, []),
            },
          );
        }),
      );

      return () => ready.dispose();
    });

  return {
    ensureProject: async (projectId) => {
      const closing = closings.get(projectId) ?? 0;
      const servers = await store.list(projectId);

      await Promise.all(
        servers
          .filter((server) => server.enabled && !disposed)
          .map((server) => ensure(projectId, server, closing)),
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
    connect: connectServer,
    stop,
    stopProject: async (projectId) => {
      closings.set(projectId, (closings.get(projectId) ?? 0) + 1);
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
      readiness.dispose();
      watchers.clear();
      const entries = [...live.values()];
      live.clear();
      await Promise.all(entries.map(halt));
    },
  };
};
