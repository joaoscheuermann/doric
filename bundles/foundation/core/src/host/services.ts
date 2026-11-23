// `core`'s data services over the router (spec
// `docs/designs/grpc-processes.md`, section 17, "Storage until phase 4"):
// `storage/v1`, `settings/v1`, `secrets/v1` and `events/v1`, served as
// generated services over `storage.backend/v1` and `secrets.backend/v1`.
// Written beside the kernel entry (`./index.ts`), which the running host
// keeps until slice S62; S41's `main.ts` lists these services in
// `runBundle`.

import { create, type Registry } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { ConnectError, type ServiceImpl } from '@connectrpc/connect';
import { ContractError, fromConnectError } from 'bundle/contracts';
import { EventsService } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { LogService } from 'bundle/contracts/gen/doric/log/v1/log_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { StartupService } from 'bundle/contracts/gen/doric/platform/startup/v1/startup_pb.js';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { SettingsService } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type {
  BundleInstance,
  HostContext,
  HostInstances,
  ServiceEntries,
} from 'bundle/host';
import type { SchemaValidators } from 'bundle/runtime';
import { serveStorage } from 'storage/rpc';

import { OnEventAppendedHookInputSchema } from '../contracts/gen/doric/core/event_hooks/v1/event_hooks_pb.js';
import { createCoreState } from '../shared/state.js';
import { type CoreBinding, createBinding } from './binding.js';
import { createEventsService } from './events/service.js';
import {
  CORE_EVENT_HOOKS,
  createHooksService,
  DEFAULT_HOOK_DEADLINE_MS,
} from './hooks/service.js';
import { createLogService } from './log/service.js';
import { createModelsService } from './models/service.js';
import { createSecretsService } from './secrets/service.js';
import { createSettingsService } from './settings/service.js';
import { createSkillsService } from './skills/service.js';
import { createStorageFacade } from './storage/facade.js';
import { createToolsService } from './tools/service.js';

/** The services `createCoreServices` answers, in this order. */
export type CoreDataServices = readonly [
  typeof StorageService,
  typeof SettingsService,
  typeof SecretsService,
  typeof EventsService,
  typeof ToolsService,
  typeof SkillsService,
  typeof HooksService,
  typeof LogService,
  typeof ModelsService,
];

export interface CoreServicesOptions {
  /**
   * The message types of settings values and event payloads, and the files
   * of the hooks contracts that bundles define. `Register` of `settings/v1`
   * and `events/v1` look up `messageType` here; `Set` and `Append` unpack
   * and validate their `Any` with it. A type missing here is refused as
   * `invalid_input`.
   *
   * `hooks/v1.Define`, `Register` and `Run` take a hooks contract's hooks
   * from the messages here whose file has `(doric.platform.v1.hooks).id`
   * equal to the contract. Each hook is a message with
   * `(doric.platform.v1.hook)`, and its name, kind and order come from that
   * option. `core.event-hooks/v1` is always known, whether or not it is here.
   * Read at every call.
   *
   * A function is called at every call that reads types, so a registry
   * loaded after `createCoreServices` (`loadCatalogTypes` in `activate`) is
   * seen from then on; a `Registry` is read as before.
   */
  readonly types: Registry | (() => Registry);
  /**
   * Compiles a `storage/v1.DefineType` JSON Schema into the rebuilt
   * definition's check, as `serveStorage` requires (`ajvValidators()` of
   * `bundle/host`).
   */
  readonly validators: SchemaValidators;
  /** The clock of `settings/v1` write times (epoch ms); `Date.now` by default. */
  readonly now?: () => number;
  /**
   * How long `hooks/v1.Run` waits for one observe, transform or decide
   * handler before it reports `hook_handler_timeout` and moves on, in ms.
   * The default is `DEFAULT_HOOK_DEADLINE_MS` (10,000); 0 means no deadline.
   * Sequence handlers never have one.
   */
  readonly hookDeadlineMs?: number;
}

/** Each service of `CoreDataServices` by name, for `main.ts`'s static list. */
export interface CoreImplementations {
  readonly storage: ServiceImpl<typeof StorageService>;
  readonly settings: ServiceImpl<typeof SettingsService>;
  readonly secrets: ServiceImpl<typeof SecretsService>;
  readonly events: ServiceImpl<typeof EventsService>;
  readonly tools: ServiceImpl<typeof ToolsService>;
  readonly skills: ServiceImpl<typeof SkillsService>;
  readonly hooks: ServiceImpl<typeof HooksService>;
  readonly log: ServiceImpl<typeof LogService>;
  readonly models: ServiceImpl<typeof ModelsService>;
}

/** `core`'s data services and the step that binds them to the instance. */
export interface CoreServices {
  /**
   * `[StorageService, …]`, `[SettingsService, …]`, `[SecretsService, …]`,
   * `[EventsService, …]`, for `runBundle`'s or
   * `createTestRouter().activate`'s `services`. Each RPC keeps today's
   * semantics and errors of the matching facade method. A `ContractError`
   * reaches the caller with its code, message and details; any other throw
   * becomes `internal`. Every RPC fails with `unavailable` until `activate`
   * ran.
   *
   * Registrations are partitioned by the router-stamped caller generation
   * (`call.caller.generation`); generation 0 is only the platform's, whose
   * reads see the catalog's active generation. `core` reaches its own
   * facades in process with `core`'s instance as the caller.
   *
   * Settings values are stored as the message's JSON with default-valued
   * fields emitted (as 1.x rows are); a stored row is read leniently (a
   * field the message lacks is ignored). A never-written space answers the
   * message's proto defaults (the empty message), since `settings/v1`'s
   * registration carries no defaults; `settings_missing` when protovalidate
   * refuses the empty message.
   *
   * `tools/v1`, `skills/v1` and `hooks/v1` keep D4's key rule
   * (`RegistrationTable`). Every registration belongs to the router-stamped
   * calling instance. A bundle's newest instance serves its keys, and the
   * registration ends with `Unregister` or that instance's `InstanceGone`.
   * Unlike `storage/v1`, `settings/v1` and `events/v1`, these three are not
   * partitioned by generation: every caller sees the serving registration of
   * every key.
   *
   * `tools/v1.Execute` and `hooks/v1.Run` call the registering instance's
   * `ToolHandlerService` and `HookHandlerService` with `target` naming it.
   * `log/v1` writes to `doric.log/v1` and reports through
   * `doric.diagnostics/v1`.
   *
   * `[ModelsService, …]`: `models/v1` over the provider bundles of
   * `models.provider/v1`, which `core` reaches through
   * `context.services.use(ProviderService, { provider })` (see
   * `createModelsService`).
   */
  readonly services: ServiceEntries<CoreDataServices>;
  /**
   * The same implementations as `services`, by name (identical objects),
   * so `src/host/main.ts` writes its `services` as the array literal of
   * `[Service, implementation]` literals the build requires (A61, A63;
   * `readStaticServices`).
   */
  readonly implementations: CoreImplementations;
  /**
   * Binds the services to `context`, from `BundleDefinition.activate`. From
   * then on they call `storage.backend/v1` through
   * `storageBackendClient(context.services.use(StorageBackendService))`,
   * `secrets.backend/v1` through `secretsBackendClient(...)`,
   * `doric.catalog/v1.Get` for `provides` and active providers, and each
   * registrant's `ReferenceSourceService` (with `target` naming the
   * registering instance). Credentials load on the first secrets call.
   *
   * It also gives `context.instances.onGone` the registrations of all four
   * services, so an `InstanceGone` disposes every registration of that
   * instance (each dispose guarded; core's own never throw). The documents
   * it wrote stay. It also drops the instance's tools, skills, hook
   * definitions and hook handlers.
   *
   * `core` defines `core.event-hooks/v1` as its own instance
   * (`context.instance`), in process and with no I/O. From then on, each
   * committed `events/v1.Append` runs `onEventAppendedHook` with
   * `OnEventAppendedHookInput{stream, type}`, without awaiting it; its
   * failure never reaches the `Append`.
   *
   * `core` registers, as its own instance and in process, a handler of
   * `doric.app.hooks/v1` `onHostStartHook` (sequence). When the host's
   * `hooks/v1.Run` of that hook reaches it, the handler, under the run's
   * call:
   * 1. `storage.backend/v1.Connect`;
   * 2. `doric.startup/v1.Stage{name: 'credential_activation'}`;
   * 3. `doric.startup/v1.Log{level: 'info', message: 'Activating stored
   *    credentials', fields: {}}`;
   * 4. loads the stored credentials into `secrets/v1`'s cache (one
   *    `secrets.backend/v1.List`, none when already loaded).
   * Any step's failure fails the handler with its `ContractError`, so the
   * run (a sequence) and the host's start fail, as today. Registering does
   * no I/O.
   *
   * Does no I/O. No backend and no catalog is reached until the first RPC
   * that needs one, and `core`'s own storage types (`core.settings/v1`,
   * `core.settings-generation/v1`) are defined on the first settings call.
   * Throws a `TypeError` when called a second time. Otherwise never throws.
   */
  activate(context: HostContext): void;
}

/**
 * Builds `core`'s data services. Has no I/O and holds no handle on any
 * process until `activate`. One instance serves one bundle process. Tests
 * make one per router, and a "restart" is a new one over the same memory
 * backend.
 */
export const createCoreServices = (
  options: CoreServicesOptions,
): CoreServices => {
  const typesOf = (): Registry =>
    typeof options.types === 'function' ? options.types() : options.types;
  const state = createCoreState(
    options.now === undefined ? {} : { now: options.now },
  );
  let binding: CoreBinding | undefined;
  const bind = (): CoreBinding => {
    if (binding === undefined) {
      throw new ContractError(
        'unavailable',
        "core's data services are not activated yet.",
      );
    }

    return binding;
  };

  // `serveStorage` subscribes before the context exists: its handlers are
  // handed to `context.instances.onGone` by `activate`.
  const goneHandlers = new Set<(instance: BundleInstance) => void>();
  const instances: HostInstances = {
    onGone: (handler) => {
      goneHandlers.add(handler);

      return () => {
        goneHandlers.delete(handler);
      };
    },
  };

  const storage = createStorageFacade(bind);
  const settings = createSettingsService(state, bind, storage, typesOf);
  const secrets = createSecretsService(state, bind);
  const events = createEventsService(
    bind,
    storage,
    (call) => secrets.redactions(call),
    typesOf,
    async (input, call) => {
      // Detached from the Append call: its end must not cancel the hook.
      const detached = Object.create(bind().own(call), {
        signal: { value: new AbortController().signal, enumerable: true },
      }) as typeof call;
      await hooks.runOwn(Object.freeze(detached), {
        contract: CORE_EVENT_HOOKS,
        hook: 'onEventAppendedHook',
        input: anyPack(
          OnEventAppendedHookInputSchema,
          create(OnEventAppendedHookInputSchema, input),
        ),
      });
    },
  );
  const tools = createToolsService(bind);
  const skills = createSkillsService(bind, tools);
  const hooks = createHooksService(
    bind,
    typesOf,
    options.hookDeadlineMs ?? DEFAULT_HOOK_DEADLINE_MS,
  );
  const log = createLogService(bind, (call) => secrets.redactions(call));
  const models = createModelsService(bind, secrets);
  const implementations: CoreImplementations = {
    storage: serveStorage(storage, {
      validators: options.validators,
      instances,
    }),
    settings: settings.implementation,
    secrets: secrets.implementation,
    events: events.implementation,
    tools: tools.implementation,
    skills: skills.implementation,
    hooks: hooks.implementation,
    log: log.implementation,
    models: models.implementation,
  };

  return {
    services: [
      [StorageService, implementations.storage],
      [SettingsService, implementations.settings],
      [SecretsService, implementations.secrets],
      [EventsService, implementations.events],
      [ToolsService, implementations.tools],
      [SkillsService, implementations.skills],
      [HooksService, implementations.hooks],
      [LogService, implementations.log],
      [ModelsService, implementations.models],
    ],
    implementations,
    activate: (context) => {
      if (binding !== undefined) {
        throw new TypeError("core's data services are already activated.");
      }

      binding = createBinding(context);
      hooks.defineOwn(context.instance, CORE_EVENT_HOOKS);

      const startup = context.services.use(StartupService);

      hooks.handleOwn(
        context.instance,
        { contract: 'doric.app.hooks/v1', hook: 'onHostStartHook' },
        async (_input, call) => {
          await bind().storageBackend.connect(call);
          try {
            await startup.stage(
              { name: 'credential_activation' },
              { signal: call.signal },
            );
            await startup.log(
              {
                level: 'info',
                message: 'Activating stored credentials',
                fields: {},
              },
              { signal: call.signal },
            );
          } catch (error) {
            throw error instanceof ConnectError
              ? fromConnectError(error)
              : error;
          }
          await secrets.load(call);

          return undefined;
        },
      );
      context.instances.onGone((instance) => {
        for (const handler of goneHandlers) {
          handler(instance);
        }

        settings.registrations.dropInstance(instance);
        secrets.registrations.dropInstance(instance);
        events.registrations.dropInstance(instance);
        tools.registrations.dropInstance(instance);
        skills.registrations.dropInstance(instance);
        hooks.registrations.dropInstance(instance);
      });
    },
  };
};
