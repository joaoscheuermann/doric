// Client commands main asks this window to run (section 18.3, revised): the
// `doric.shell/v1.commands` stream, answered with `commandResult`.

import {
  CommandsV1,
  type Disposable,
  type Services,
  toContractError,
} from 'bundle/contracts';

import { shellNotify, shellStream } from './bridge.js';
import type { DoricDesktopApi, ShellCommandRequest } from './protocol.js';

export const serveShellCommands = (input: {
  readonly desktop: DoricDesktopApi;
  /** Services of the window platform principal. */
  readonly services: Services;
}): Disposable => {
  const { desktop, services } = input;

  return shellStream<ShellCommandRequest>(desktop, 'commands', (request) => {
    void (async () => {
      try {
        await services
          .use(CommandsV1)
          .execute(
            request.command as `${string}/v${number}`,
            request.input ?? {},
          );
        shellNotify(desktop, 'commandResult', { id: request.id, ok: true });
      } catch (error) {
        const contractError = toContractError(error);

        shellNotify(desktop, 'commandResult', {
          id: request.id,
          ok: false,
          error: {
            code: contractError.code,
            message: contractError.message,
            ...(contractError.details === undefined
              ? {}
              : { details: contractError.details }),
          },
        });
      }
    })();
  });
};
