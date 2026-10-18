import {
  type HookHandle,
  HooksV1,
  type HostContext,
  StorageV1,
} from 'bundle/contracts';

import { CoreEventHooksV1 } from '../contracts/hooks.js';
import { settingsGenerationType, settingsType } from '../contracts/storage.js';
import { createHooks, type HooksOptions } from '../shared/hooks.js';
import { createLog } from '../shared/log.js';
import { createCoreState } from '../shared/state.js';
import { createEvents } from './events/facade.js';
import { createModels } from './models/index.js';
import { activateCredentials } from './secrets/activation.js';
import { createSecrets } from './secrets/facade.js';
import { createSettings } from './settings/facade.js';
import { createSkills } from './skills.js';
import { createStorage } from './storage/facade.js';
import { createTools } from './tools.js';

export {
  DEFAULT_HOOK_DEADLINE_MS,
  type HooksOptions,
} from '../shared/hooks.js';

export interface CoreOptions {
  readonly hooks?: HooksOptions;
  /** The clock of `settings/v1` write times (epoch ms); `Date.now` by default. */
  readonly now?: () => number;
}

/**
 * The core's host part with its options, for tests that need a shorter hook
 * deadline or a fixed clock. Each `provide` is inert when the composition
 * chose another provider for that contract. Activation does no I/O: storage
 * types are declared to the backend on first use and credentials are read on
 * the first secrets call.
 */
export const createActivate =
  (options: CoreOptions = {}) =>
  ({ services }: HostContext): void => {
    const state = createCoreState(
      options.now === undefined ? {} : { now: options.now },
    );

    services.provide(createHooks(options.hooks));

    // `core.event-hooks/v1`: the hooks `events/v1` fires after each append.
    // A host without a catalog (a unit test) cannot define it, and appends
    // then tell no one.
    let eventHooks: HookHandle<typeof CoreEventHooksV1> | undefined;

    try {
      eventHooks = services.use(HooksV1).define(CoreEventHooksV1);
    } catch {
      eventHooks = undefined;
    }

    services.provide(createLog());
    services.provide(createTools());
    services.provide(createSkills());
    services.provide(createStorage(state));
    services.provide(createSecrets(state));
    services.provide(createEvents(state, () => eventHooks));
    services.provide(createSettings(state));
    services.provide(createModels(services));

    // The core's own types, through whichever storage/v1 is active.
    const storage = services.use(StorageV1);

    storage.defineType(settingsType);
    storage.defineType(settingsGenerationType);

    // The start step: storage connection, then the stored credentials.
    activateCredentials(services);
  };

/**
 * Provides the default basic services of the host: hooks, log, tools,
 * skills, storage, secrets, events, settings and models.
 */
export const activate = createActivate();
