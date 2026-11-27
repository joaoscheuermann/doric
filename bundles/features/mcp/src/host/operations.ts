// The bodies of `mcp/v1`, `default.skill-sources/v1` and the runtime hooks
// (S59 D1), served by the process's services.

import { randomUUID } from 'node:crypto';

import {
  type Call,
  ContractError,
  type Disposable,
  isContractError,
} from 'bundle/contracts';
import type { SkillSourceEntry } from 'default/contracts';

import {
  type McpServerInput,
  type McpServerView,
  type McpSkillRef,
  type McpSkillText,
  mcpScopeMessage,
  serverSlug,
} from '../contracts/index.js';
import { assertEntryCredentials, type OAuthVault } from './credentials.js';
import type { McpManager } from './manager.js';
import type { SignIns } from './oauth.js';
import type { McpPorts } from './ports.js';
import {
  parseSkillReference,
  skillOrigin,
  skillSourceEntries,
} from './skills.js';
import { newDocument, type ServerDocument, type ServerStore } from './store.js';

/** What the operations run over; built by the process's `activate`. */
export interface McpOperationsDeps {
  readonly ports: McpPorts;
  readonly store: ServerStore;
  readonly vault: OAuthVault;
  readonly manager: McpManager;
  readonly signIns: SignIns;
}

/**
 * The bodies of `mcp/v1`, `default.skill-sources/v1` and the hooks, moved from the kernel entry unchanged. Every method
 * takes the Project already read from the call (`projectOf`). Errors are today's `ContractError`s (§4).
 */
export interface McpOperations {
  /** The Project's servers in creation order with their live state; never connects. */
  list(projectId: string): Promise<readonly McpServerView[]>;
  /**
   * Checks the entries' credentials under `call` (`invalid_input` for an MCP_TOKEN one), then, under the Project's
   * lock, refuses a taken slug (`mcp_server_name_taken`), stores the new document and answers its view; the
   * connection is applied in the background (a failure becomes its status or a `warn`).
   */
  create(
    projectId: string,
    input: McpServerInput,
    call: Call,
  ): Promise<McpServerView>;
  /** Today's `update` (`mcp_server_missing`, `mcp_server_name_taken`, `invalid_input`); a moved transport forgets
   *  the OAuth state and cancels its sign-in; the reconnection runs in the background. */
  update(
    projectId: string,
    id: string,
    input: McpServerInput,
    call: Call,
  ): Promise<McpServerView>;
  /** Forgets the server and its MCP_TOKEN credentials, then stops it and cancels its sign-in; `mcp_server_missing`. */
  remove(projectId: string, id: string): Promise<void>;
  /**
   * Delivers the Project's servers now, then after every change, to `listener` until the answer is disposed, and
   * connects every enabled server not connected yet in the background. Disposing keeps the connections. Never throws.
   */
  watch(
    projectId: string,
    listener: (servers: readonly McpServerView[]) => void,
  ): Disposable;
  /** `{url}` of a new sign-in; `mcp_server_missing`, `mcp_signin_unsupported`, `mcp_signin_aborted`,
   *  `mcp_signin_failed`. Uses `call.signal` only. */
  signIn(
    projectId: string,
    id: string,
    call: Call,
  ): Promise<{ readonly url: string }>;
  /** Waits for the browser (≤ 10 min), stores the tokens, reconnects and answers the view; `mcp_server_missing`,
   *  `mcp_signin_not_started`, `mcp_signin_busy`, `mcp_signin_aborted`, `mcp_signin_failed`. */
  finishSignIn(
    projectId: string,
    id: string,
    call: Call,
  ): Promise<McpServerView>;
  /** One skill's text; `mcp_server_missing`, `mcp_skill_unavailable`. */
  readSkill(
    projectId: string,
    ref: McpSkillRef,
    signal?: AbortSignal,
  ): Promise<McpSkillText>;
  /** The skills of the Project's connected servers (`skillSourceEntries`). */
  listSkillSources(projectId: string): Promise<readonly SkillSourceEntry[]>;
  /** `invalid_input` 'The reference names no MCP server and skill.', `mcp_server_missing`, `mcp_skill_unavailable`. */
  readSkillSource(
    projectId: string,
    reference: string,
    signal?: AbortSignal,
  ): Promise<{ readonly origin: string; readonly text: string }>;
  /** Resolves once connecting the Project's servers ended or after 10 s; never rejects (a failure is a `warn`). */
  promptStarted(projectId: string): Promise<void>;
  /** Stops the Project's servers; resolves once stopped. */
  projectClosing(projectId: string): Promise<void>;
  /** `manager.sandboxReady`; never rejects (a failure is a `warn`). */
  projectReady(projectId: string): Promise<void>;
  /** Today's `forgetProject`; never rejects (a failure is logged at `error`). */
  projectDeleted(projectId: string): Promise<void>;
  /** Cancels every sign-in, then stops every server; nothing connects afterwards. */
  dispose(): Promise<void>;
}

/** Builds the operations; no I/O. */
export const createMcpOperations = ({
  ports,
  store,
  vault,
  manager,
  signIns,
}: McpOperationsDeps): McpOperations => {
  const { log } = ports;

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

  /** Refuses entries naming a credential no server entry may use. */
  const assertCredentials = (
    { transport }: McpServerInput,
    call: Call,
  ): Promise<void> =>
    assertEntryCredentials(
      transport.kind === 'http' ? transport.headers : transport.env,
      ports.secrets,
      call,
    );

  /**
   * Deletes a server and the credentials of its OAuth state, as stored when
   * no other change of it runs; `mcp_server_missing` when it is gone or
   * another Project's.
   */
  const forgetServer = (projectId: string, id: string): Promise<void> =>
    store.lock(id, async () => {
      const server = await serverOf(projectId, id);
      await vault.forget(server.oauth);
      await store.remove(id);
    });

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
    const forgotten = await store.lockProject(projectId, async () => {
      const servers = await store.list(projectId);

      for (const server of servers) {
        // A server a concurrent `remove` took is gone already.
        await forgetServer(projectId, server.id).catch((error: unknown) => {
          if (!isContractError(error) || error.code !== 'mcp_server_missing') {
            throw error;
          }
        });
      }

      return servers;
    });
    // After the removal, as `remove` does.
    await manager.stopProject(projectId);

    for (const server of forgotten) {
      await signIns.cancel(server.id);
    }

    manager.publish(projectId);
  };

  return {
    list: (projectId) => manager.snapshot(projectId),
    create: async (projectId, input, call) => {
      await assertCredentials(input, call);
      const server = await store.lockProject(projectId, async () => {
        await assertNameFree(projectId, input.name);
        const created = newDocument({
          ...input,
          id: randomUUID(),
          projectId,
        });
        await store.put(created);

        return created;
      });
      reconcile(server);

      return manager.viewOf(server);
    },
    update: async (projectId, id, input, call) => {
      await assertCredentials(input, call);
      const { server, moved } = await store.lockProject(projectId, () =>
        store.lock(id, async () => {
          const stored = await serverOf(projectId, id);
          await assertNameFree(projectId, input.name, id);
          const { oauth, ...rest } = stored;
          const moving = movedServer(stored.transport, input.transport);
          if (moving) await vault.forget(oauth);
          const next: ServerDocument = {
            ...rest,
            ...input,
            ...(moving || oauth === undefined ? {} : { oauth }),
            updatedAt: new Date().toISOString(),
          };
          await store.put(next);

          return { server: next, moved: moving };
        }),
      );
      // Outside the locks: a sign-in under way saves through them.
      if (moved) await signIns.cancel(id);
      reconcile(server);

      return manager.viewOf(server);
    },
    remove: async (projectId, id) => {
      await forgetServer(projectId, id);
      // After the removal, never under its lock: stopping waits for a
      // connect under way, which may save through that lock, and a
      // server started meanwhile finds itself gone.
      await manager.stop(id);
      await signIns.cancel(id);
      manager.publish(projectId);
    },
    watch: (projectId, listener) => {
      const subscription = manager.subscribe(projectId, listener);
      void connectProject(projectId);

      return subscription;
    },
    signIn: async (projectId, id, call) =>
      signIns.start(await serverOf(projectId, id), call),
    finishSignIn: async (projectId, id, call) => {
      await signIns.finish(await serverOf(projectId, id), call);
      await manager.connect(id);

      return manager.viewOf(await serverOf(projectId, id));
    },
    readSkill: async (projectId, { id, uri }, signal) => {
      const server = await serverOf(projectId, id);

      return { text: await manager.readSkill(server, uri, signal) };
    },
    listSkillSources: async (projectId) =>
      skillSourceEntries(await manager.snapshot(projectId)),
    readSkillSource: async (projectId, reference, signal) => {
      const parsed = parseSkillReference(reference);
      if (parsed === undefined) {
        throw new ContractError(
          'invalid_input',
          'The reference names no MCP server and skill.',
        );
      }
      const server = await serverOf(projectId, parsed.serverId);

      return {
        origin: skillOrigin(server.name, parsed.uri),
        text: await manager.readSkill(server, parsed.uri, signal),
      };
    },
    promptStarted: async (projectId) => {
      // A prompt waits for its Project's tools, but never long, and a
      // server that cannot connect never fails the prompt.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PROMPT_WAIT_MS);
      });

      await Promise.race([connectProject(projectId), waited]);
      clearTimeout(timer);
    },
    projectClosing: (projectId) => manager.stopProject(projectId),
    projectReady: (projectId) =>
      manager.sandboxReady(projectId).catch((error: unknown) => {
        log().warn('The MCP servers waiting for a sandbox could not connect', {
          projectId,
          error:
            error instanceof Error
              ? error.message || error.name
              : String(error),
        });
      }),
    projectDeleted: (projectId) =>
      forgetProject(projectId).catch((error: unknown) => {
        log().error(
          'The MCP servers of a deleted Project could not be removed',
          {
            projectId,
            error: messageOf(error),
          },
        );
      }),
    dispose: async () => {
      await signIns.dispose();
      await manager.dispose();
    },
  };
};

/** `call.scope.projectId`; `ContractError('invalid_input', mcpScopeMessage)` when absent or empty. */
export const projectOf = (call: Call): string => {
  const projectId = call.scope?.projectId;

  if (projectId === undefined || projectId === '') {
    throw new ContractError('invalid_input', mcpScopeMessage);
  }

  return projectId;
};

/** How long a starting prompt waits for its Project's servers. */
const PROMPT_WAIT_MS = 10_000;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether a transport change leaves the stored OAuth state another server's. */
const movedServer = (
  before: ServerDocument['transport'],
  after: McpServerInput['transport'],
): boolean =>
  before.kind !== after.kind ||
  (before.kind === 'http' && after.kind === 'http' && before.url !== after.url);
