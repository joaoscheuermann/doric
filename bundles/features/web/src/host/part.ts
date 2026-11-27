// `web`'s host part (phase 3, S50a): the web tool served from the bundle's
// `ToolHandlerService` and registered with `tools/v1`.

import type {
  HandlerRegistration,
  HostContext,
  ToolHandlers,
} from 'bundle/host';

import { createTool, type WebToolOptions } from './tools/web.js';

/**
 * Serves the web tool from `tools` and registers it with `tools/v1`
 * (`tools.register(context, createTool(options).bind(undefined),
 * { alwaysAvailable: true, order: 700 })`, the model-visible position 700).
 * Resolves with the registration once `Register` resolved; replayed after a
 * `core` restart by `context.registrations`. Rejects with the provider's
 * `ContractError` (`duplicate_tool`, `invalid_input`); nothing is then served.
 */
export const registerWebTool = (
  context: Pick<HostContext, 'registrations'>,
  tools: ToolHandlers,
  options?: WebToolOptions,
): Promise<HandlerRegistration> =>
  tools.register(context, createTool(options).bind(undefined), {
    alwaysAvailable: true,
    order: 700,
  });
