import {
  type BoundCommand,
  type CommandDefinition,
  CommandsV1,
  ContractError,
  commandsMethods,
  DoricWindowsV1,
  defineCommand,
  defineMethod,
  defineService,
} from 'bundle/contracts';

import { openSettingsInput } from '../contracts/index.js';
import { describeIssues } from '../shared/issues.js';
import { once } from '../shared/state.js';
import { SETTINGS_APPEARANCE } from './appearance.js';

/**
 * `core.open-settings/v1`: opens the settings window at `path`, `/settings`
 * by default. `doric.windows/v1` focuses the window when it is already open
 * and navigates it when the path differs (P2).
 */
export const openSettings = defineCommand({
  id: 'core.open-settings/v1',
  input: openSettingsInput,
  execute: async ({ path }, call, services) => {
    await services.use(DoricWindowsV1).open(
      {
        key: 'settings',
        path: path ?? '/settings',
        appearance: SETTINGS_APPEARANCE,
      },
      call,
    );
  },
});

// `OpenSettingsCommandV1` in core/contracts is a ref to this exact type; the
// assignment fails to compile if the two ever drift apart.
const sameType: CommandDefinition<
  'core.open-settings/v1',
  typeof openSettingsInput
> = openSettings;

void sameType;

/**
 * The desktopMain `commands/v1`: a registry of bound commands by ID. A
 * duplicate ID is a `registration_conflict`; executing an ID nobody
 * registered is `unknown_command` [S8-17], which main answers by asking the
 * focused window next. Menus and keybindings execute with `{}` (decision 77).
 */
export const createCommands = () => {
  const registry = new Map<string, BoundCommand>();

  // By ID: the tuple input is checked here, not against the ref's types.
  return defineService(CommandsV1.id, {
    register: defineMethod({
      input: commandsMethods.register.input,
      output: commandsMethods.register.output,
      execute: (bound) => {
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
      execute: async ([command, input], call) => {
        const id = typeof command === 'string' ? command : command.id;
        const bound = registry.get(id);

        if (bound === undefined) {
          throw new ContractError(
            'unknown_command',
            `No command "${id}" is registered here.`,
            { command: id },
          );
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
