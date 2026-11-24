// `mcp`'s host part as a process (phase 3, S59): `mcp/v1`,
// `default.skill-sources/v1`, the MCP tools and the `runtime.hooks/v1`
// handlers served over the routed ports.

import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf, type Disposable } from 'bundle/contracts';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  contractErrorOf,
  createHookHandlers,
  createToolHandlers,
  type HookHandlers,
  type HostContext,
  type ToolHandlers,
} from 'bundle/host';
import type { SkillSourcesService } from 'default/contracts/gen/doric/default/skill_sources/v1/skill_sources_pb.js';
import {
  OnProjectClosingHookInputSchema,
  OnProjectReadyHookInputSchema,
  OnPromptStartedHookInputSchema,
} from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';

import type { McpService } from '../contracts/gen/doric/mcp/v1/mcp_pb.js';
import {
  serverInputOf,
  serverViewMessageOf,
  skillSourceEntryMessageOf,
} from './codec.js';
import { createOAuthVault, mcpTokenKind } from './credentials.js';
import { createManager } from './manager.js';
import { createSignIns } from './oauth.js';
import {
  createMcpOperations,
  type McpOperations,
  projectOf,
} from './operations.js';
import { routedMcpPorts, watchProjectDeletions } from './routed.js';
import { createServerStore, serverType } from './store.js';
import { type StreamSink, streamOf } from './stream.js';

/** One `Watch` item: the Project's whole list. */
interface WatchItem {
  readonly servers: ReturnType<typeof serverViewMessageOf>[];
}

export interface McpHost {
  /**
   * `mcp/v1`; each method answers `unavailable` until activation, then reads `projectOf(callOf(context))`, then:
   * - `List` → `{servers}`; `Create`/`Update` → `serverInputOf`, the operation with `callOf(context)`, `{mcpServerView}`;
   * - `Remove` → `{}`; `SignIn` → `{url}`; `FinishSignIn` → `{mcpServerView}`; `ReadSkill` → `{text}` with the call's
   *   signal;
   * - `Watch` → `streamOf(sink => operations.watch(projectId, servers => sink.next({servers: …})),
   *   callOf(context).signal)`: the present list first, then the whole list after every change; ends when the caller
   *   cancels; the connections stay.
   * Errors: §4; `unavailable` 'mcp is not active.' before `activate` resolved or after `deactivate`.
   */
  readonly mcp: ServiceImpl<typeof McpService>;
  /** `default.skill-sources/v1`: `List{cwd}` → `{skills}`; `Read{reference}` → `{origin, text}` with the call's signal.
   *  Same scope rule and `unavailable` as `mcp`. */
  readonly skillSources: ServiceImpl<typeof SkillSourcesService>;
  /** The tool table `main.ts` serves as `ToolHandlerService`. */
  readonly tools: ToolHandlers;
  /** The hook table `main.ts` serves as `HookHandlerService`. */
  readonly hooks: HookHandlers;
  /**
   * In order, steps 1–3 rejecting `activate` on failure (the services then stay `unavailable`):
   * 1. `routedMcpPorts(context, tools)`; `storage.defineType(serverType)`, then `await storage.settled()`
   *    (`registration_conflict`, `invalid_input`, `not_owner` reject);
   * 2. `context.registrations.track(SecretsService, c => c.registerKind({credentialKindDefinition: MCP_TOKEN}))`
   *    (`duplicate_credential_kind` rejects);
   * 3. `hooks.register` of `OnPromptStartedHookInputSchema` → `promptStarted`, `OnProjectClosingHookInputSchema` →
   *    `projectClosing`, `OnProjectReadyHookInputSchema` → `projectReady`, each answering `{}` after its work (D8);
   * 4. `watchProjectDeletions(context, id => void operations.projectDeleted(id))`;
   * 5. the services answer.
   * Makes no `tools/v1`, `runtime.lease/v1` or `runtime.attachments/v1` call and connects nothing.
   */
  activate(
    context: Pick<HostContext, 'services' | 'registrations' | 'log'>,
  ): Promise<void>;
  /** Services answer `unavailable`; stops the deletion watch, then `operations.dispose()` (sign-ins, servers, their
   *  tools and `Start` streams). Resolves once done; never rejects. */
  deactivate(): Promise<void>;
}

/** Builds the part with no I/O; never throws. */
export const createMcpHost = (): McpHost => {
  const tools = createToolHandlers();
  const hooks = createHookHandlers();
  let operations: McpOperations | undefined;
  let deletions: Disposable | undefined;
  let log: HostContext['log'] | undefined;

  /** The live operations, the call and its Project; throws `unavailable` while not active. */
  const scoped = (context: Parameters<typeof callOf>[0]) => {
    if (operations === undefined) {
      throw new ContractError('unavailable', 'mcp is not active.');
    }
    const call = callOf(context);

    return { live: operations, call, projectId: projectOf(call) };
  };

  return {
    mcp: {
      list: async (_request, context) => {
        const { live, projectId } = scoped(context);
        const servers = await live.list(projectId);

        return { servers: servers.map(serverViewMessageOf) };
      },
      create: async (request, context) => {
        const { live, call, projectId } = scoped(context);
        const input = serverInputOf(request.mcpServerInput, 'Create');
        const view = await live.create(projectId, input, call);

        return { mcpServerView: serverViewMessageOf(view) };
      },
      update: async (request, context) => {
        const { live, call, projectId } = scoped(context);
        const input = serverInputOf(request.mcpServerInput, 'Update');
        const view = await live.update(projectId, request.id, input, call);

        return { mcpServerView: serverViewMessageOf(view) };
      },
      remove: async (request, context) => {
        const { live, projectId } = scoped(context);
        await live.remove(projectId, request.id);

        return {};
      },
      watch: async function* (_request, context) {
        const { live, call, projectId } = scoped(context);

        yield* streamOf(
          (sink: StreamSink<WatchItem>) =>
            live.watch(projectId, (servers) =>
              sink.next({ servers: servers.map(serverViewMessageOf) }),
            ),
          call.signal,
        );
      },
      signIn: async (request, context) => {
        const { live, call, projectId } = scoped(context);

        return await live.signIn(projectId, request.id, call);
      },
      finishSignIn: async (request, context) => {
        const { live, call, projectId } = scoped(context);
        const view = await live.finishSignIn(projectId, request.id, call);

        return { mcpServerView: serverViewMessageOf(view) };
      },
      readSkill: async (request, context) => {
        const { live, call, projectId } = scoped(context);
        const skill = { id: request.id, uri: request.uri };

        return await live.readSkill(projectId, skill, call.signal);
      },
    },
    skillSources: {
      list: async (_request, context) => {
        const { live, projectId } = scoped(context);
        const skills = await live.listSkillSources(projectId);

        return { skills: skills.map(skillSourceEntryMessageOf) };
      },
      read: async (request, context) => {
        const { live, call, projectId } = scoped(context);

        return await live.readSkillSource(
          projectId,
          request.reference,
          call.signal,
        );
      },
    },
    tools,
    hooks,
    activate: async (context) => {
      const { ports, storage } = routedMcpPorts(context, tools);
      storage.defineType(serverType);
      await storage.settled();

      await context.registrations.track(SecretsService, async (client) => {
        try {
          return await client.registerKind({
            credentialKindDefinition: {
              id: mcpTokenKind.id,
              required: [...mcpTokenKind.required],
              optional: [...mcpTokenKind.optional],
              label: mcpTokenKind.label,
            },
          });
        } catch (error) {
          throw contractErrorOf(error);
        }
      });

      const store = createServerStore(ports.storage);
      const vault = createOAuthVault({ store, secrets: ports.secrets });
      const manager = createManager({ ports, store, vault });
      const signIns = createSignIns({ vault, log: ports.log });
      const built = createMcpOperations({
        ports,
        store,
        vault,
        manager,
        signIns,
      });

      await hooks.register(context, OnPromptStartedHookInputSchema, (input) =>
        built.promptStarted(input.projectId),
      );
      await hooks.register(context, OnProjectClosingHookInputSchema, (input) =>
        built.projectClosing(input.projectId),
      );
      await hooks.register(context, OnProjectReadyHookInputSchema, (input) =>
        built.projectReady(input.projectId),
      );

      deletions = watchProjectDeletions(context, (projectId) => {
        void built.projectDeleted(projectId);
      });
      log = context.log;
      operations = built;
    },
    deactivate: async () => {
      const live = operations;
      operations = undefined;
      deletions?.dispose();
      deletions = undefined;
      try {
        await live?.dispose();
      } catch (error) {
        log?.warn('The MCP servers could not all be stopped.', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
};
