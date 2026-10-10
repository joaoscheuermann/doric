import {
  ContractError,
  DoricWindowsV1,
  defineMethod,
  defineService,
  HooksV1,
  type OpenWindowRequest,
  WindowsV1,
  windowsMethods,
} from 'bundle/contracts';

import { CoreHooksV1 } from '../contracts/index.js';

/**
 * The core's window policy over a request the hooks adjusted. Stage 8 keeps
 * it to the identity (API mínima): the only refusal, an empty key, is
 * checked before the hooks run.
 */
const applyCorePolicy = (request: OpenWindowRequest): OpenWindowRequest =>
  request;

/**
 * The core's `windows/v1` (windows.md): `core.hooks/v1.onBeforeOpenWindowHook`
 * adjusts the request, the core's policy applies, and `doric.windows/v1`
 * opens the window under the key `<caller bundle>:<key>`. Handlers see and
 * may change everything but the key, which stays the caller's.
 */
export const coreWindows = defineService(WindowsV1, {
  open: defineMethod({
    input: windowsMethods.open.input,
    output: windowsMethods.open.output,
    execute: async (request, call, services) => {
      if (request.key === '') {
        throw new ContractError(
          'invalid_input',
          'A window key must not be empty.',
        );
      }

      const coreHooks = services.use(HooksV1).define(CoreHooksV1);
      const adjusted = await coreHooks.onBeforeOpenWindowHook.execute(
        request,
        call,
      );

      await services.use(DoricWindowsV1).open(
        {
          ...applyCorePolicy(adjusted),
          key: `${call.caller.bundleId}:${request.key}`,
        },
        call,
      );
    },
  }),
});
