import type { HostContext } from 'bundle/contracts';

import { createHooks, type HooksOptions } from './hooks.js';
import { createLog } from './log.js';
import { createSkills } from './skills.js';
import { createTools } from './tools.js';

export { DEFAULT_HOOK_DEADLINE_MS, type HooksOptions } from './hooks.js';

/**
 * The core's host part with its options, for tests that need a shorter hook
 * deadline. Each `provide` is inert when the composition chose another
 * provider for that contract.
 */
export const createActivate =
  (options: { readonly hooks?: HooksOptions } = {}) =>
  ({ services }: HostContext): void => {
    services.provide(createHooks(options.hooks));
    services.provide(createLog());
    services.provide(createTools());
    services.provide(createSkills());
  };

/** Provides the default basic services of the host: hooks, log, tools and skills. */
export const activate = createActivate();
