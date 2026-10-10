import {
  type Call,
  CommandsV1,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';

import { CoreCommandsV1, coreCommandsMethods } from '../contracts/index.js';

/**
 * `core.commands/v1` (stage 9, D9-8): where the core's client `commands/v1`
 * sends a command no part of its window registered. It runs the desktopMain
 * `commands/v1`; a miss there is its `unknown_command`, unchanged.
 */
export const createCommandsBridge = () =>
  defineService(CoreCommandsV1, {
    execute: defineMethod({
      input: coreCommandsMethods.execute.input,
      output: coreCommandsMethods.execute.output,
      execute: async (
        { id, input }: { readonly id: string; readonly input?: unknown },
        call: Call,
        services: Services,
      ) => {
        await services
          .use(CommandsV1)
          .execute(id as `${string}/v${number}`, input ?? {}, call);
      },
    }),
  });
