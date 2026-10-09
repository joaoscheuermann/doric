import { type CommandDefinition, ref } from 'bundle/contracts';
import { z } from 'zod';

/** Input of the core's open-settings command: an optional settings path. */
export const openSettingsInput = z
  .object({ path: z.string().optional() })
  .strict();

/**
 * Opens the settings window. The command's definition arrives with the core's
 * desktop part in stage 8, structurally identical to this reference, so
 * consumers never change their import.
 */
export const OpenSettingsCommandV1 = ref<
  CommandDefinition<'core.open-settings/v1', typeof openSettingsInput>
>('core.open-settings/v1');
