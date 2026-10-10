// The core's client commands/v1 (stage 9, §4.8): the window's registry of
// bound commands. A command nobody registered in this window runs in
// desktopMain through `core.commands/v1` (decision "Comandos"); a miss there
// is `unknown_command`, propagated unchanged.

import {
  type BoundCommand,
  type Call,
  CommandsV1,
  ContractError,
  commandsMethods,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';

import { CoreCommandsV1 } from '../contracts/commands.js';
import { describeIssues } from '../shared/issues.js';
import { once } from './disposable.js';

export const createCommands = () => {
  const registry = new Map<string, BoundCommand>();

  // By ID: the tuple input is checked here, not against the ref's types.
  return defineService(CommandsV1.id, {
    register: defineMethod({
      input: commandsMethods.register.input,
      output: commandsMethods.register.output,
      execute: (bound: BoundCommand) => {
        if (registry.has(bound.id)) {
          throw new ContractError(
            'registration_conflict',
            `Command ${bound.id} is already registered.`,
            { command: bound.id },
          );
        }

        registry.set(bound.id, bound);

        return once(() => {
          if (registry.get(bound.id) === bound) {
            registry.delete(bound.id);
          }
        });
      },
    }),
    execute: defineMethod({
      input: commandsMethods.execute.input,
      output: commandsMethods.execute.output,
      execute: async (
        [command, input]: [string | { kind: 'ref'; id: string }, unknown?],
        call: Call,
        services: Services,
      ) => {
        const id = typeof command === 'string' ? command : command.id;
        const bound = registry.get(id);

        if (bound === undefined) {
          await services
            .use(CoreCommandsV1)
            .execute({ id, input: input ?? {} }, call);

          return;
        }

        const parsed = bound.input.safeParse(input ?? {});

        if (!parsed.success) {
          throw new ContractError(
            'invalid_input',
            `Invalid input for ${id}: ${describeIssues(parsed.error)}`,
            { command: id },
          );
        }

        await bound.execute(parsed.data, call);
      },
    }),
  });
};
