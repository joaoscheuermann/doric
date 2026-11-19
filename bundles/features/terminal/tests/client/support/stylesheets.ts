// The client entry reaches the terminal view, which imports xterm's
// stylesheet; Node loads no CSS, so a stylesheet loads as an empty module
// here (`module.registerHooks`, Node 22.15+; the repository's @types/node
// predates it), as `sidebar-rows.test.ts` does.

import * as nodeModule from 'node:module';

let registered = false;

/** Loads every `.css` import as an empty module from now on; idempotent. */
export const loadStylesheetsAsEmpty = (): void => {
  if (registered) return;
  registered = true;
  (
    nodeModule as unknown as {
      registerHooks(hooks: {
        load(
          url: string,
          context: unknown,
          next: (url: string, context: unknown) => unknown,
        ): unknown;
      }): void;
    }
  ).registerHooks({
    load: (url, context, next) =>
      url.endsWith('.css')
        ? { format: 'module', source: '', shortCircuit: true }
        : next(url, context),
  });
};
