import {
  defineHook,
  defineHooks,
  openWindowRequestSchema,
} from 'bundle/contracts';
import { z } from 'zod';

/**
 * Runs before the core opens a window, so a bundle can adjust the request.
 * The core defines it from its desktop part; handlers cannot change the key.
 */
export const onBeforeOpenWindowHook = defineHook({
  kind: 'transform',
  input: openWindowRequestSchema,
});

/** Hooks the core owns (`core.hooks/v1`, desktopMain from stage 8). */
export const CoreHooksV1 = defineHooks('core.hooks/v1', {
  onBeforeOpenWindowHook,
});

/**
 * Fired, without waiting, after `events/v1.append` committed a row to the
 * stream of an event sink. It names the stream and the event type only — the
 * core knows no scope key of any sink — so the sink's owner reads what it
 * needs from the stream itself. The `runtime` observes it to publish what
 * other bundles append to a Thread's log the moment it is committed.
 */
export const onEventAppendedHook = defineHook({
  kind: 'observe',
  input: z.object({ stream: z.string(), type: z.string() }).strict(),
});

/** Hooks the core owns on the host (`core.event-hooks/v1`). */
export const CoreEventHooksV1 = defineHooks('core.event-hooks/v1', {
  onEventAppendedHook,
});
