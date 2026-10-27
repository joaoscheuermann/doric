// The `mcp` bundle's host part: provides mcp/v1 over the stored servers and
// their live connections, connects a Project's servers when a prompt of it
// starts, stops them when it closes, and forgets them (credentials included)
// when it is deleted. Everything it opened ends when the bundle deactivates.

import { randomUUID } from 'node:crypto';

import {
  type Call,
  type Cleanup,
  ContractError,
  defineMethod,
  defineService,
  HooksV1,
  type HostContext,
  LogV1,
  SecretsV1,
  StorageV1,
  type StreamListener,
  toStreamObserver,
} from 'bundle/contracts';
import { RuntimeHooksV1, RuntimeV1 } from 'runtime/contracts';

import {
  type McpServerInput,
  type McpServerView,
  McpV1,
  mcpMethods,
  mcpScopeMessage,
} from '../contracts/index.js';
import { createOAuthVault, mcpTokenKind } from './credentials.js';
import { createManager } from './manager.js';
import { createSignIns } from './oauth.js';
import {
  createServerStore,
  newDocument,
  type ServerDocument,
  serverType,
} from './store.js';
import { serverSlug } from './tools.js';

/** How long a starting prompt waits for its Project's servers. */
const PROMPT_WAIT_MS = 10_000;

const projectOf = (call: Call): string => {
  const projectId = call.scope?.projectId;

  if (projectId === undefined || projectId === '') {
    throw new ContractError('invalid_input', mcpScopeMessage);
  }

  return projectId;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether a transport change leaves the stored OAuth state another server's. */
const movedServer = (
  before: ServerDocument['transport'],
  after: McpServerInput['transport'],
): boolean =>
  before.kind !== after.kind ||
  (before.kind === 'http' && after.kind === 'http' && before.url !== after.url);

export const activate = ({ services }: HostContext): Cleanup => {
  const storage = services.use(StorageV1);
  const secrets = services.use(SecretsV1);
  const log = () => services.use(LogV1);
  const type = storage.defineType(serverType);
  const kind = secrets.registerKind(mcpTokenKind);
  const store = createServerStore(storage);
  const vault = createOAuthVault({ store, secrets });
  const manager = createManager({ services, store, vault });
  const signIns = createSignIns({ vault, log });

  /** The Project's server of that id, else `mcp_server_missing`. */
  const serverOf = async (
    projectId: string,
    id: string,
  ): Promise<ServerDocument> => {
    const server = await store.get(id);

    if (server === undefined || server.projectId !== projectId) {
      throw new ContractError(
        'mcp_server_missing',
        `The Project holds no MCP server ${id}.`,
      );
    }

    return server;
  };

  /** Refuses a name whose slug another server of the Project already has. */
  const assertNameFree = async (
    projectId: string,
    name: string,
    id?: string,
  ): Promise<void> => {
    const slug = serverSlug(name);
    const servers = await store.list(projectId);

    if (
      servers.some(
        (server) => server.id !== id && serverSlug(server.name) === slug,
      )
    ) {
      throw new ContractError(
        'mcp_server_name_taken',
        `Another MCP server of the Project is named like ${name}.`,
      );
    }
  };

  /** Applies a stored change in the background; its failure is the server's status, or logged. */
  const reconcile = (server: ServerDocument): void => {
    manager.reconcile(server).catch((error: unknown) => {
      log().warn('An MCP server could not apply its configuration', {
        serverId: server.id,
        error: messageOf(error),
      });
    });
  };

  /** Connects the Project's enabled servers; a failure is only logged. */
  const connectProject = (projectId: string): Promise<void> =>
    manager.ensureProject(projectId).catch((error: unknown) => {
      log().warn('The MCP servers of a Project could not connect', {
        projectId,
        error: messageOf(error),
      });
    });

  /** Stops the servers of a Project and forgets them and their tokens. */
  const forgetProject = async (projectId: string): Promise<void> => {
    await manager.stopProject(projectId);

    for (const server of await store.list(projectId)) {
      await vault.forget(server.oauth);
      await store.remove(server.id);
    }

    manager.publish(projectId);
  };

  const providing = services.provide(
    // By id: `watch` takes its listener as a one-item tuple (that is what
    // marks a stream for the desktop bridge), which the interface-derived
    // check would read as the bare listener.
    defineService(McpV1.id, {
      list: defineMethod({
        ...mcpMethods.list,
        execute: async (_input: readonly [], call: Call) =>
          manager.snapshot(projectOf(call)),
      }),
      create: defineMethod({
        ...mcpMethods.create,
        execute: async (
          input: McpServerInput,
          call: Call,
        ): Promise<McpServerView> => {
          const projectId = projectOf(call);
          await assertNameFree(projectId, input.name);
          const server = newDocument({ ...input, id: randomUUID(), projectId });
          await store.put(server);
          reconcile(server);

          return manager.viewOf(server);
        },
      }),
      update: defineMethod({
        ...mcpMethods.update,
        execute: async (
          { id, ...input }: McpServerInput & { readonly id: string },
          call: Call,
        ): Promise<McpServerView> => {
          const projectId = projectOf(call);
          const server = await store.lock(id, async () => {
            const stored = await serverOf(projectId, id);
            await assertNameFree(projectId, input.name, id);
            const { oauth, ...rest } = stored;
            const moved = movedServer(stored.transport, input.transport);
            if (moved) await vault.forget(oauth);
            const next: ServerDocument = {
              ...rest,
              ...input,
              ...(moved || oauth === undefined ? {} : { oauth }),
              updatedAt: new Date().toISOString(),
            };
            await store.put(next);

            return next;
          });
          reconcile(server);

          return manager.viewOf(server);
        },
      }),
      remove: defineMethod({
        ...mcpMethods.remove,
        execute: async ({ id }: { readonly id: string }, call: Call) => {
          const projectId = projectOf(call);
          const server = await serverOf(projectId, id);
          await manager.stop(id);
          await vault.forget(server.oauth);
          await store.remove(id);
          manager.publish(projectId);
        },
      }),
      watch: defineMethod({
        ...mcpMethods.watch,
        execute: (
          [listener]: [StreamListener<McpServerView[]>],
          call: Call,
        ) => {
          const projectId = projectOf(call);
          const observer = toStreamObserver(listener);
          const subscription = manager.subscribe(projectId, (servers) => {
            const delivered: unknown = observer.next([...servers]);
            // A remote listener answers a promise; its failure is the window's.
            if (delivered instanceof Promise) delivered.catch(() => undefined);
          });
          void connectProject(projectId);

          return subscription;
        },
      }),
      signIn: defineMethod({
        ...mcpMethods.signIn,
        execute: async ({ id }: { readonly id: string }, call: Call) =>
          signIns.start(await serverOf(projectOf(call), id), call),
      }),
      finishSignIn: defineMethod({
        ...mcpMethods.finishSignIn,
        execute: async (
          { id }: { readonly id: string },
          call: Call,
        ): Promise<McpServerView> => {
          const projectId = projectOf(call);
          await signIns.finish(await serverOf(projectId, id), call);
          await manager.connect(id);

          return manager.viewOf(await serverOf(projectId, id));
        },
      }),
    }),
  );

  const hooks = services
    .use(HooksV1)
    .whenAvailable(RuntimeHooksV1, (registrar) => {
      const started = registrar.onPromptStartedHook(async ({ projectId }) => {
        // A prompt waits for its Project's tools, but never long, and a
        // server that cannot connect never fails the prompt.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waited = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PROMPT_WAIT_MS);
        });

        await Promise.race([connectProject(projectId), waited]);
        clearTimeout(timer);
      });
      const closing = registrar.onProjectClosingHook(({ projectId }) =>
        manager.stopProject(projectId),
      );

      return () => {
        started.dispose();
        closing.dispose();
      };
    });

  const watching = services.whenAvailable(RuntimeV1, (runtime) => {
    const subscription = runtime.watch((notice) => {
      if (notice.kind !== 'projectDeleted') return;
      forgetProject(notice.projectId).catch((error: unknown) => {
        log().error(
          'The MCP servers of a deleted Project could not be removed',
          {
            projectId: notice.projectId,
            error: messageOf(error),
          },
        );
      });
    });

    return () => subscription.dispose();
  });

  return async () => {
    watching.dispose();
    hooks.dispose();
    providing.dispose();
    await signIns.dispose();
    await manager.dispose();
    kind.dispose();
    type.dispose();
  };
};
