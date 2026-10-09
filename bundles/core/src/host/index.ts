import { type HostContext, StorageV1 } from 'bundle/contracts';

import { settingsGenerationType, settingsType } from '../contracts/storage.js';
import { createEvents } from './events/facade.js';
import { createHooks, type HooksOptions } from './hooks.js';
import { createLog } from './log.js';
import { createSecrets } from './secrets/facade.js';
import { createSettings } from './settings/facade.js';
import { createSkills } from './skills.js';
import { createCoreState } from './state.js';
import { createStorage } from './storage/facade.js';
import { createTools } from './tools.js';

export { DEFAULT_HOOK_DEADLINE_MS, type HooksOptions } from './hooks.js';

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
    services.provide(createLog());
    services.provide(createTools());
    services.provide(createSkills());
    services.provide(createStorage(state));
    services.provide(createSecrets(state));
    services.provide(createEvents(state));
    services.provide(createSettings(state));

    // The core's own types, through whichever storage/v1 is active.
    const storage = services.use(StorageV1);

    storage.defineType(settingsType);
    storage.defineType(settingsGenerationType);
  };

/**
 * Provides the default basic services of the host: hooks, log, tools,
 * skills, storage, secrets, events and settings.
 */
export const activate = createActivate();
