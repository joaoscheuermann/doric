import {
  defineHook,
  defineHooks,
  openWindowRequestSchema,
} from 'bundle/contracts';

/**
 * Runs before the core opens a window, so a bundle can adjust the request.
 * The core defines it from its desktop part, which arrives in stage 8; until
 * then the contract is published so consumers can be written against it.
 */
export const onBeforeOpenWindowHook = defineHook({
  kind: 'transform',
  input: openWindowRequestSchema,
});

/** Hooks the core owns (`core.hooks/v1`, desktopMain from stage 8). */
export const CoreHooksV1 = defineHooks('core.hooks/v1', {
  onBeforeOpenWindowHook,
});
