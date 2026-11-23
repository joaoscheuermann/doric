// `threads`' host part (phase 3, S52b): the eight delegation tools served
// from the bundle's `ToolHandlerService` and registered with `tools/v1`.

import type {
  HandlerRegistration,
  HostContext,
  ToolHandlers,
} from 'bundle/host';

import { routedThreadToolPorts } from './routed.js';
import { threadTools } from './tools/catalog.js';

/**
 * Serves each `threadTools` entry from `tools`, bound to
 * `routedThreadToolPorts(context.services)`, and registers it with `tools/v1`
 * in catalog order (`{alwaysAvailable: true, order}`), replayed after a
 * `core` restart. Resolves once all eight `Register`s resolved; rejects with
 * the first refusal (`duplicate_tool`, `invalid_input`). The tools registered
 * before a refusal stay registered and served, as with eight kernel
 * registrations.
 */
export const registerThreadTools = async (
  context: Pick<HostContext, 'services' | 'registrations'>,
  tools: ToolHandlers,
): Promise<readonly HandlerRegistration[]> => {
  const ports = routedThreadToolPorts(context.services);
  const registrations: HandlerRegistration[] = [];

  for (const { tool, order } of threadTools) {
    registrations.push(
      await tools.register(context, tool.bind(ports), {
        alwaysAvailable: true,
        order,
      }),
    );
  }

  return registrations;
};
