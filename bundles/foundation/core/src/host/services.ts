// `core`'s data services over the router (spec
// `docs/designs/grpc-processes.md`, section 17, "Storage until phase 4"):
// `storage/v1` and `settings/v1` (slice S39a; `secrets/v1` and `events/v1`
// join in S39b), served as generated services over `storage.backend/v1` and
// `secrets.backend/v1`. Written beside the kernel entry (`./index.ts`), which
// the running host keeps until slice S62; S41's `main.ts` lists these
// services in `runBundle`.

import type { Registry } from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';
import { SettingsService } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import type {
  BundleInstance,
  HostContext,
  HostInstances,
  ServiceEntries,
} from 'bundle/host';
import type { SchemaValidators } from 'bundle/runtime';
import { serveStorage } from 'storage/rpc';

import { createCoreState } from '../shared/state.js';
import { type CoreBinding, createBinding } from './binding.js';
import { createSettingsService } from './settings/service.js';
import { createStorageFacade } from './storage/facade.js';

/**
 * The services `createCoreServices` answers, in this order. S39b widens it
 * to `[StorageService, SettingsService, SecretsService, EventsService]`.
 */
export type CoreDataServices = readonly [
  typeof StorageService,
  typeof SettingsService,
];

export interface CoreServicesOptions {
  /**
   * The message types of settings values. `Register` of `settings/v1` looks
   * up `messageType` here; `Set` unpacks and validates its `Any` with it. A
   * type missing here is refused as `invalid_input`. Read at every call.
   */
  readonly types: Registry;
  /**
   * Compiles a `storage/v1.DefineType` JSON Schema into the rebuilt
   * definition's check, as `serveStorage` requires (`ajvValidators()` of
   * `bundle/host`).
   */
  readonly validators: SchemaValidators;
  /** The clock of `settings/v1` write times (epoch ms); `Date.now` by default. */
  readonly now?: () => number;
}

/** `core`'s data services and the step that binds them to the instance. */
export interface CoreServices {
  /**
   * `[StorageService, …]` and `[SettingsService, …]`, for `runBundle`'s or
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
   */
  readonly services: ServiceEntries<CoreDataServices>;
  /**
   * Binds the services to `context`, from `BundleDefinition.activate`. From
   * then on they call `storage.backend/v1` through
   * `storageBackendClient(context.services.use(StorageBackendService))` and
   * `doric.catalog/v1.Get` for `provides` and active providers.
   *
   * It also gives `context.instances.onGone` the registrations of both
   * services, so an `InstanceGone` disposes every registration of that
   * instance (each dispose guarded; core's own never throw). The documents
   * it wrote stay.
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
  const settings = createSettingsService(
    state,
    bind,
    storage,
    () => options.types,
  );

  return {
    services: [
      [
        StorageService,
        serveStorage(storage, { validators: options.validators, instances }),
      ],
      [SettingsService, settings.implementation],
    ],
    activate: (context) => {
      if (binding !== undefined) {
        throw new TypeError("core's data services are already activated.");
      }

      binding = createBinding(context);
      context.instances.onGone((instance) => {
        for (const handler of goneHandlers) {
          handler(instance);
        }

        settings.registrations.dropInstance(instance);
      });
    },
  };
};
