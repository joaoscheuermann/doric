import { ContractError, defineMethod, defineService } from 'bundle/contracts';
import { TerminalV1, terminalMethods } from 'terminal/contracts';

import type { Bindings } from '../domain/bindings.js';

/*
 * terminal/v1, provisional in the runtime until stage 10 (design 57 §2.6,
 * D-S5-03): the calling prompt's live terminals, as the stage-1 adapter
 * forwarded them.
 */
export const terminalService = (bindings: Bindings) =>
  defineService(TerminalV1, {
    run: defineMethod({
      ...terminalMethods.run,
      execute: (input, call) => {
        const terminals = bindings.bound(call).host.terminals;

        // A facade without live terminals leaves the tool its plain-command
        // fallback, exactly as when no terminal provider exists at all.
        if (terminals === undefined)
          throw new ContractError(
            'unavailable',
            'This prompt has no live terminals.',
          );

        return terminals.run(input);
      },
    }),
  });
