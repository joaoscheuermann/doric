import { type CallArg, type CommandDefinition, ref } from 'bundle/contracts';
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

/** Input of `core.commands/v1.execute`: a command ID and its input. */
export const coreCommandsExecuteInput = z
  .object({ id: z.string(), input: z.unknown() })
  .strict();

/**
 * Internal to the core (stage 9, D9-8): the client `commands/v1` sends a
 * command no part of the window registered to desktopMain through it.
 * Provided in desktopMain, where it runs `commands/v1.execute(id, input)`;
 * a miss there is `unknown_command`.
 */
export interface CoreCommands {
  execute(
    input: z.input<typeof coreCommandsExecuteInput>,
    call?: CallArg,
  ): Promise<void>;
}

export const CoreCommandsV1 = ref<CoreCommands>('core.commands/v1');

export const coreCommandsMethods = {
  execute: {
    input: coreCommandsExecuteInput,
    output: z.void(),
    expose: 'desktop',
  },
} as const;
