// The `mcp` bundle's host part: provides mcp/v1 over the stored servers and
// their live connections and `default.skill-sources/v1` over their skills,
// connects a Project's servers when a prompt of it starts, stops them when it
// closes, and forgets them (credentials included) when it is deleted.
// Everything it opened ends when the bundle deactivates.

import {
  type Call,
  type Cleanup,
  defineMethod,
  defineService,
  HooksV1,
  type HostContext,
  SecretsV1,
  StorageV1,
  type StreamListener,
  toStreamObserver,
} from 'bundle/contracts';
import { SkillSourcesV1, skillSourcesMethods } from 'default/contracts';
import { RuntimeHooksV1, RuntimeV2 } from 'runtime/contracts';

import {
  type McpServerInput,
  type McpServerView,
  type McpSkillRef,
  type McpSkillText,
  McpV1,
  mcpMethods,
} from '../contracts/index.js';
import { createOAuthVault, mcpTokenKind } from './credentials.js';
import { createManager } from './manager.js';
import { createSignIns } from './oauth.js';
import { createMcpOperations, projectOf } from './operations.js';
import { kernelMcpPorts } from './ports.js';
import { createServerStore, serverType } from './store.js';

export const activate = ({ services }: HostContext): Cleanup => {
  const ports = kernelMcpPorts(services);
  const type = services.use(StorageV1).defineType(serverType);
  const kind = services.use(SecretsV1).registerKind(mcpTokenKind);
  const store = createServerStore(ports.storage);
  const vault = createOAuthVault({ store, secrets: ports.secrets });
  const manager = createManager({ ports, store, vault });
  const signIns = createSignIns({ vault, log: ports.log });
  const operations = createMcpOperations({
    ports,
    store,
    vault,
    manager,
    signIns,
  });

  const providing = services.provide(
    // By id: `watch` takes its listener as a one-item tuple (that is what
    // marks a stream for the desktop bridge), which the interface-derived
    // check would read as the bare listener.
    defineService(McpV1.id, {
      list: defineMethod({
        ...mcpMethods.list,
        execute: async (_input: readonly [], call: Call) =>
          operations.list(projectOf(call)),
      }),
      create: defineMethod({
        ...mcpMethods.create,
        execute: async (
          input: McpServerInput,
          call: Call,
        ): Promise<McpServerView> =>
          operations.create(projectOf(call), input, call),
      }),
      update: defineMethod({
        ...mcpMethods.update,
        execute: async (
          { id, ...input }: McpServerInput & { readonly id: string },
          call: Call,
        ): Promise<McpServerView> =>
          operations.update(projectOf(call), id, input, call),
      }),
      remove: defineMethod({
        ...mcpMethods.remove,
        execute: async ({ id }: { readonly id: string }, call: Call) =>
          operations.remove(projectOf(call), id),
      }),
      watch: defineMethod({
        ...mcpMethods.watch,
        execute: (
          [listener]: [StreamListener<McpServerView[]>],
          call: Call,
        ) => {
          const projectId = projectOf(call);
          const observer = toStreamObserver(listener);

          return operations.watch(projectId, (servers) => {
            const delivered: unknown = observer.next([...servers]);
            // A remote listener answers a promise; its failure is the window's.
            if (delivered instanceof Promise) delivered.catch(() => undefined);
          });
        },
      }),
      signIn: defineMethod({
        ...mcpMethods.signIn,
        execute: async ({ id }: { readonly id: string }, call: Call) =>
          operations.signIn(projectOf(call), id, call),
      }),
      finishSignIn: defineMethod({
        ...mcpMethods.finishSignIn,
        execute: async (
          { id }: { readonly id: string },
          call: Call,
        ): Promise<McpServerView> =>
          operations.finishSignIn(projectOf(call), id, call),
      }),
      readSkill: defineMethod({
        ...mcpMethods.readSkill,
        execute: async (ref: McpSkillRef, call: Call): Promise<McpSkillText> =>
          operations.readSkill(projectOf(call), ref, call.signal),
      }),
    }),
  );

  // The skills of the Project's connected servers, offered to `default`'s
  // agent: listed from what `manager` holds, read as `readSkill` reads them.
  const offering = services.provide(
    defineService(
      SkillSourcesV1,
      {
        list: defineMethod({
          ...skillSourcesMethods.list,
          execute: async (_input: { readonly cwd: string }, call: Call) => ({
            skills: await operations.listSkillSources(projectOf(call)),
          }),
        }),
        read: defineMethod({
          ...skillSourcesMethods.read,
          execute: async (
            { reference }: { readonly reference: string },
            call: Call,
          ) =>
            operations.readSkillSource(projectOf(call), reference, call.signal),
        }),
      },
      { cardinality: 'many' },
    ),
  );

  const hooks = services
    .use(HooksV1)
    .whenAvailable(RuntimeHooksV1, (registrar) => {
      const started = registrar.onPromptStartedHook(({ projectId }) =>
        operations.promptStarted(projectId),
      );
      const closing = registrar.onProjectClosingHook(({ projectId }) =>
        operations.projectClosing(projectId),
      );

      return () => {
        started.dispose();
        closing.dispose();
      };
    });

  // A server waiting for its Project's sandbox connects once it is ready.
  const readiness = services
    .use(HooksV1)
    .whenAvailable(RuntimeHooksV1, (registrar) => {
      const ready = registrar.onProjectReadyHook(({ projectId }) =>
        operations.projectReady(projectId),
      );

      return () => ready.dispose();
    });

  const watching = services.whenAvailable(RuntimeV2, (runtime) => {
    const subscription = runtime.watch((notice) => {
      if (notice.kind !== 'projectDeleted') return;
      void operations.projectDeleted(notice.projectId);
    });

    return () => subscription.dispose();
  });

  return async () => {
    watching.dispose();
    hooks.dispose();
    providing.dispose();
    offering.dispose();
    readiness.dispose();
    await operations.dispose();
    kind.dispose();
    type.dispose();
  };
};
