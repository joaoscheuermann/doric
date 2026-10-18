import {
  type Caller,
  ContractError,
  DoricMenusV1,
  defineMethod,
  defineService,
  MenusV1,
  menusMethods,
} from 'bundle/contracts';

/** The registering bundle, as `doric.menus/v1` records it. */
const ownerOf = ({ bundleId, version, generation }: Caller): Caller => ({
  bundleId,
  version,
  generation,
});

/**
 * The core's `menus/v1` (menus-and-keybindings.md). On the hop to
 * `doric.menus/v1` the caller becomes the core, so each registration names
 * its owner, the bundle that called `menus/v1`. A context belongs to the
 * calling window, whose key the dispatcher put in `call.scope`.
 */
export const coreMenus = defineService(MenusV1, {
  addItem: defineMethod({
    input: menusMethods.addItem.input,
    output: menusMethods.addItem.output,
    execute: async (item, call, services) => {
      await services
        .use(DoricMenusV1)
        .add({ ...item, owner: ownerOf(call.caller) }, call);
    },
  }),
  addKeybinding: defineMethod({
    input: menusMethods.addKeybinding.input,
    output: menusMethods.addKeybinding.output,
    execute: async (binding, call, services) => {
      await services
        .use(DoricMenusV1)
        .addKeybinding({ ...binding, owner: ownerOf(call.caller) }, call);
    },
  }),
  setContext: defineMethod({
    input: menusMethods.setContext.input,
    output: menusMethods.setContext.output,
    execute: async (entry, call, services) => {
      const windowKey = call.scope?.windowKey;

      if (windowKey === undefined) {
        throw new ContractError(
          'invalid_input',
          'setContext needs a calling window',
        );
      }

      await services
        .use(DoricMenusV1)
        .setContext({ windowKey, ...entry }, call);
    },
  }),
});
