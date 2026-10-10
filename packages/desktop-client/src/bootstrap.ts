// bootstrapWindow: the shell sequence of every window (section 15.2).

import { activateClientBundles, type ImportPart } from './activate.js';
import { applyChrome } from './chrome.js';
import { type FlushParticipants, wireClose } from './close.js';
import { serveShellCommands } from './commands.js';
import { installKeybindings } from './keybindings.js';
import type { DoricDesktopApi, WindowDescription } from './protocol.js';

export interface BootstrapOptions {
  /**
   * Stage 8: the legacy mount; stage 9 replaces it with the core outlet.
   */
  readonly mount: (context: {
    readonly description: WindowDescription;
  }) => void | Promise<void>;
  /** Extra participants of the flush phase (stage 8: legacy onFlush listeners). */
  readonly flushParticipants?: FlushParticipants;
  /** Default `window.doric.desktop` (tests inject). */
  readonly desktop?: DoricDesktopApi;
  readonly document?: Document;
  /** Default dynamic `import()` (tests inject). */
  readonly importPart?: ImportPart;
  /** Target of the keydown listener; default `window`. */
  readonly keyTarget?: Pick<
    EventTarget,
    'addEventListener' | 'removeEventListener'
  >;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const defaultDesktop = (): DoricDesktopApi =>
  (globalThis as unknown as { doric: { desktop: DoricDesktopApi } }).doric
    .desktop;

export const bootstrapWindow = async (
  options: BootstrapOptions,
): Promise<void> => {
  const desktop = options.desktop ?? defaultDesktop();
  const document = options.document ?? globalThis.document;
  let failure: { readonly bundleId: string; readonly message: string } | null;

  try {
    const description = await desktop.describeWindow();
    const root = document.documentElement;

    applyChrome(description.chrome, root);
    desktop.onChromeChanged((chrome) => applyChrome(chrome, root));

    const catalog = await desktop.catalog();
    const activation = await activateClientBundles({
      catalog,
      desktop,
      description,
      document,
      ...(options.importPart === undefined
        ? {}
        : { importPart: options.importPart }),
    });

    wireClose({
      desktop,
      windowHooks: activation.windowHooks,
      ...(options.flushParticipants === undefined
        ? {}
        : { flushParticipants: options.flushParticipants }),
    });
    installKeybindings({
      desktop,
      ...(options.keyTarget === undefined ? {} : { target: options.keyTarget }),
    });
    serveShellCommands({ desktop, services: activation.services });
    await options.mount({ description });

    const core = catalog.resolved.composition.core;

    failure =
      description.key === 'workspace' &&
      activation.diagnostics.state(core) === 'quarantined'
        ? {
            bundleId: core,
            message:
              activation.diagnostics
                .reasons(core)
                .map((reason) => reason.message)
                .join('; ') || `Core bundle "${core}" is quarantined.`,
          }
        : null;
  } catch (error) {
    await desktop.reportFailure({
      kind: 'bootstrap',
      message: messageOf(error),
    });

    return;
  }

  if (failure !== null) {
    await desktop.reportFailure({ kind: 'core', ...failure });

    return;
  }

  await desktop.ready();
};
