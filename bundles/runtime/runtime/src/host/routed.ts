// The runtime's ports, stores and registrations over the router (phase 3,
// slice S46a): each port keeps today's contract (`ports.ts`), each call goes
// through `context.services`.

import type { DescMessage } from '@bufbuild/protobuf';
import { toJson } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { ContractError, secretSchema } from 'bundle/contracts';
import { EventsService } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { GenerationService } from 'bundle/contracts/gen/doric/platform/generation/v1/generation_pb.js';
import {
  type Secret as SecretMessage,
  SecretSchema,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import type { HostContext } from 'bundle/host';
import { doricConfigurationSchema } from 'host-config/contracts';
import {
  DoricConfigurationSchema,
  HostConfigService,
} from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import { type StorageClient, storageClient } from 'storage/rpc';

import { threadEventSink } from '../contracts/events.js';
import {
  OnProjectClosingHookInputSchema,
  OnProjectReadyHookInputSchema,
  OnPromptStartedHookInputSchema,
  OnThreadCwdChangedHookInputSchema,
  OnThreadsClosingHookInputSchema,
} from '../contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';
import { PromptFinishedSchema } from '../contracts/gen/doric/runtime/prompt_finished/v1/prompt_finished_pb.js';
import { checkStorageHealth } from './domain/storage-pressure.js';
import type { RuntimePorts } from './ports.js';
import { routedSandbox } from './routed-sandbox.js';
import { decode, encode } from './rpc/codec.js';
import { routed } from './rpc/errors.js';
import { runtimeStorageTypes } from './store/index.js';

/** The contract runtime's observe hooks belong to. */
const RUNTIME_HOOKS = 'runtime.hooks/v1';

/** A secret `secrets/v1` answered, as today's `Secret`. */
const secretOf = (secret: SecretMessage) =>
  secretSchema.parse(toJson(SecretSchema, secret));

/**
 * `RuntimePorts` over `context.services` (each port keeps today's contract,
 * `ports.ts`):
 * - `configuration()`: `host-config/v1.Current`, decoded and parsed with
 *   `doricConfigurationSchema`.
 * - `credentials.byId(id)`: `secrets/v1.Resolve{credentialRef:{id}}`'s
 *   secret; rejects with the provider's `ContractError` (`credential_missing`
 *   for a missing id, as today).
 * - `credentials.byKind(kind)`: `ResolveByKind{kind}`; undefined for none;
 *   `credential_ambiguous` rejects.
 * - `credentials.byUnclaimedKind(kind, claimed)`: `ResolveByKind{kind,
 *   exclude: [...claimed]}`.
 * - `storedRedactions()`: `secrets/v1.Redactions`.
 * - `claimedCredentials`: per configured provider, `models/v1.Kind{id:
 *   kind}`; the `secret` fields' values.
 * - `catalogSource(providerId)`: an object whose `models()` calls
 *   `models/v1.Models{providerId}` and answers `{id, contextWindow?}` per
 *   model.
 * - `checkStorage()`: `checkStorageHealth(storage)` (the 10 % rule),
 *   unchanged.
 * - `log`: `context.log`.
 * - `hooks`: {@link routedRuntimeHooks}.
 * - `generation()`: `doric.generation/v1.Describe`'s `{generation,
 *   incarnation}`; undefined when the call fails, as today.
 * - `sandbox`: `routedSandbox(context.services)` (S47).
 * - `executor`: the given port (`routedExecutor`, S48b).
 * A routed failure rejects with `fromConnectError`'s `ContractError`. No call
 * is made until a port is used.
 */
export const routedPorts = (
  context: Pick<HostContext, 'services' | 'log' | 'registrations'>,
  storage: StorageClient,
  hooks: RuntimePorts['hooks'],
  executor: RuntimePorts['executor'],
): RuntimePorts => {
  const { services } = context;
  const secrets = () => services.use(SecretsService);
  const models = () => services.use(ModelsService);

  return {
    configuration: () =>
      routed(async () => {
        const { doricConfiguration } = await services
          .use(HostConfigService)
          .current({});
        return doricConfigurationSchema.parse(
          doricConfiguration === undefined
            ? undefined
            : decode(DoricConfigurationSchema, doricConfiguration),
        );
      }),
    credentials: {
      byId: (id) =>
        routed(async () => {
          const { secret } = await secrets().resolve({ credentialRef: { id } });
          if (secret === undefined)
            throw new ContractError(
              'invalid_output',
              'secrets/v1.Resolve answered no secret.',
            );
          return secretOf(secret);
        }),
      byKind: (kind) =>
        routed(async () => {
          const { secret } = await secrets().resolveByKind({ kind });
          return secret === undefined ? undefined : secretOf(secret);
        }),
      byUnclaimedKind: (kind, claimed) =>
        routed(async () => {
          const { secret } = await secrets().resolveByKind({
            kind,
            exclude: [...claimed],
          });
          return secret === undefined ? undefined : secretOf(secret);
        }),
    },
    storedRedactions: () =>
      routed(async () => (await secrets().redactions({})).redactions),
    claimedCredentials: ({ providers }) =>
      routed(async () => {
        const ids = new Set<string>();
        for (const provider of providers) {
          const { modelKindDescriptor } = await models().kind({
            id: provider.kind,
          });
          for (const field of modelKindDescriptor?.fields ?? []) {
            if (field.kind !== 'secret') continue;
            const id = provider.configuration[field.key];
            if (id !== undefined) ids.add(id);
          }
        }
        return ids;
      }),
    sandbox: routedSandbox(services),
    executor,
    checkStorage: () => checkStorageHealth(storage),
    catalogSource: async (providerId) => ({
      models: () =>
        routed(async () =>
          (await models().models({ providerId })).models.map(
            ({ id, contextWindow }) =>
              contextWindow === undefined ? { id } : { id, contextWindow },
          ),
        ),
    }),
    log: context.log,
    hooks,
    generation: async () => {
      try {
        const { generation, incarnation } = await services
          .use(GenerationService)
          .describe({});
        return { generation, incarnation };
      } catch {
        return undefined;
      }
    },
  };
};

/** `runtime.hooks/v1`, defined and run through `hooks/v1`. */
export interface RoutedRuntimeHooks {
  /**
   * The port. Each method runs `hooks/v1.Run{contract: 'runtime.hooks/v1',
   * hook, input: anyPack(<hook input>)}`.
   */
  readonly hooks: RuntimePorts['hooks'];
  /**
   * `hooks/v1.Define{contract: 'runtime.hooks/v1'}` through
   * `context.registrations.track(HooksService, …)`, replayed after a `core`
   * restart. Resolves once `Define` resolved; rejects with its error.
   */
  readonly defined: Promise<void>;
}

/**
 * Starts the definition (no `Run` before `defined` settles).
 * - `projectReady` and `projectClosing` start the run and return at once.
 * - `threadsClosing`, `promptStarted` and `cwdChanged` resolve once the run
 *   settled.
 * - Each input is `encode`d into its `On…HookInput` message (`projectId`,
 *   `threadIds`, `source`, `cwd`, `cwdRepo?`, `promptId?`).
 * - A failed `Define` or `Run` is swallowed, as an observe hook never fails
 *   what fired it.
 */
export const routedRuntimeHooks = (
  context: Pick<HostContext, 'services' | 'registrations'>,
): RoutedRuntimeHooks => {
  const defined = routed(async () => {
    await context.registrations.track(HooksService, (client) =>
      routed(() => client.define({ contract: RUNTIME_HOOKS })),
    );
  });
  // A failed definition only fails `defined`; each run swallows it.
  const settled = defined.catch(() => undefined);
  const run = async <D extends DescMessage>(
    hook: string,
    schema: D,
    input: unknown,
  ): Promise<void> => {
    try {
      await settled;
      await context.services.use(HooksService).run({
        contract: RUNTIME_HOOKS,
        hook,
        input: anyPack(schema, encode(schema, input)),
      });
    } catch {
      // An observe hook never fails what fired it.
    }
  };

  return {
    defined,
    hooks: {
      projectReady: (projectId) => {
        void run('onProjectReadyHook', OnProjectReadyHookInputSchema, {
          projectId,
        });
      },
      projectClosing: (projectId) => {
        void run('onProjectClosingHook', OnProjectClosingHookInputSchema, {
          projectId,
        });
      },
      threadsClosing: (input) =>
        run('onThreadsClosingHook', OnThreadsClosingHookInputSchema, input),
      promptStarted: (input) =>
        run('onPromptStartedHook', OnPromptStartedHookInputSchema, input),
      cwdChanged: (input) =>
        run('onThreadCwdChangedHook', OnThreadCwdChangedHookInputSchema, input),
    },
  };
};

/**
 * runtime's registrations over the router, each tracked for replay:
 * 1. `storage/v1.DefineType` for each of `runtimeStorageTypes`, through
 *    `storageClient(use(StorageService), {registrations})`, which is the
 *    answered `storage`;
 * 2. `events/v1.Register{type: 'runtime.prompt-finished/v1', messageType:
 *    PromptFinishedSchema.typeName}`;
 * 3. `events/v1.Sink{scopeKeys: ['projectId','threadId','promptId'], stream:
 *    'runtime.thread.events/{threadId}', scopeDescription: 'a project, a
 *    Thread and a prompt'}` (today's `threadEventSink`).
 * Resolves once all settled and `storage.settled()` resolved. Rejects with
 * the first refusal, so `activate` fails as today on a refused type.
 */
export const routedRegistrations = async (
  context: Pick<HostContext, 'services' | 'registrations'>,
): Promise<{ readonly storage: StorageClient }> => {
  const storage = storageClient(context.services.use(StorageService), {
    registrations: context.registrations,
  });
  for (const type of runtimeStorageTypes) storage.defineType(type);
  await Promise.all([
    context.registrations.track(EventsService, (client) =>
      routed(() =>
        client.register({
          type: 'runtime.prompt-finished/v1',
          messageType: PromptFinishedSchema.typeName,
        }),
      ),
    ),
    context.registrations.track(EventsService, (client) =>
      routed(() =>
        client.sink({
          scopeKeys: [...threadEventSink.scopeKeys],
          stream: threadEventSink.stream,
          scopeDescription: threadEventSink.scopeDescription,
        }),
      ),
    ),
    storage.settled(),
  ]);

  return { storage };
};
