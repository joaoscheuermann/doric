import type {
  AnyHookHandler,
  HookHandle,
  HookRegistrar,
  Hooks,
  HooksProvider,
} from '../contracts/basic/hooks.js';
import type { CallArg } from '../contracts/call.js';
import type { Cleanup, Disposable } from '../contracts/context.js';
import { type HooksContract, isHooksContract } from '../contracts/define.js';
import { ContractError } from '../contracts/error.js';
import type { Principal } from './principal.js';

const assertContract = (contract: unknown): HooksContract => {
  if (!isHooksContract(contract)) {
    throw new ContractError(
      'invalid_input',
      'Expected a hooks contract created with defineHooks.',
    );
  }

  return contract;
};

/**
 * The consumer API of hooks/v1 over the provider's flat methods. Every hop is
 * a real dispatcher hop, so `call.caller` is the owner or the registrant.
 */
export const createHooksFacade = (
  principal: Principal,
  provider: HooksProvider,
  /** Refuses a hooks contract the consumer may not `use` (outside requires). */
  assertUse?: (contractId: string) => void,
): Hooks => {
  const registrar = <C extends HooksContract>(contract: C): HookRegistrar<C> =>
    Object.freeze(
      Object.fromEntries(
        Object.keys(contract.hooks).map((hook) => [
          hook,
          (handler: AnyHookHandler): Disposable =>
            provider.register(contract, hook, handler),
        ]),
      ),
    ) as HookRegistrar<C>;

  return Object.freeze({
    define: <C extends HooksContract>(contract: C): HookHandle<C> => {
      assertContract(contract);

      const cached = principal.hookHandles.get(contract.id);

      if (cached !== undefined) {
        return cached as HookHandle<C>;
      }

      provider.define(contract);

      const handle = Object.freeze(
        Object.fromEntries(
          Object.keys(contract.hooks).map((hook) => [
            hook,
            Object.freeze({
              execute: (input: unknown, call?: CallArg) =>
                call === undefined
                  ? provider.execute(contract, hook, input)
                  : provider.execute(contract, hook, input, call),
            }),
          ]),
        ),
      ) as HookHandle<C>;

      principal.hookHandles.set(contract.id, handle);

      return handle;
    },
    use: <C extends HooksContract>(contract: C): HookRegistrar<C> => {
      assertUse?.(assertContract(contract).id);

      return registrar(contract);
    },
    whenAvailable: <C extends HooksContract>(
      contract: C,
      // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
      callback: (registrar: HookRegistrar<C>) => void | Cleanup,
    ): Disposable => {
      assertContract(contract);

      return provider.whenDefined(contract, () =>
        callback(registrar(contract)),
      );
    },
  });
};
