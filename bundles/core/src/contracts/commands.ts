import { type CommandDefinition, ref } from 'bundle/contracts';
import { z } from 'zod';

/** Input of the core's open-settings command: an optional settings path. */
export const openSettingsInput = z
  .object({ path: z.string().optional() })
  .strict();

/**
 * Opens the settings window. The definition is `openSettings` in the core's
 * desktop part; this reference has its exact type, which the part checks at
 * compile time, so the contracts never import the part.
 */
export const OpenSettingsCommandV1 = ref<
  CommandDefinition<'core.open-settings/v1', typeof openSettingsInput>
>('core.open-settings/v1');
