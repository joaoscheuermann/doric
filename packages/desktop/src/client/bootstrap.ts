// bootstrapWindow: the shell sequence of every window (section 15.2).

import { activateClientBundles, type ImportPart } from './activate.js';
import { applyChrome } from './chrome.js';
import { wireClose } from './close.js';
import { serveShellCommands } from './commands.js';
import type { ElementRegistry } from './elements.js';
import { installKeybindings } from './keybindings.js';
import type {
  DoricConnectApi,
  DoricDesktopApi,
  WindowDescription,
} from './protocol.js';

export interface BootstrapOptions {
  /**
   * A custom mount (fixture shells). Without it, as in the product shell, the
   * window shows the core outlet: `<${core}-outlet>` replaces the body's
   * children (D9-1).
   */
  readonly mount?: (context: {
    readonly description: WindowDescription;
  }) => void | Promise<void>;
  /** Default `window.doric.desktop` (tests inject). */
  readonly desktop?: DoricDesktopApi;
  readonly document?: Document;
  /** Default dynamic `import()` (tests inject). */
  readonly importPart?: ImportPart;
  /** Default `globalThis.customElements` (tests inject). */
  readonly elementRegistry?: () => ElementRegistry;
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

/** `window.doric.connect`, when the preload exposes it. */
const defaultConnect = (): DoricConnectApi | undefined =>
  (globalThis as unknown as { doric?: { connect?: DoricConnectApi } }).doric
    ?.connect;

export const bootstrapWindow = async (
  options: BootstrapOptions,
): Promise<void> => {
  const desktop = options.desktop ?? defaultDesktop();
  const connect = defaultConnect();
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
      ...(connect === undefined ? {} : { connect }),
      description,
      document,
      ...(options.importPart === undefined
        ? {}
        : { importPart: options.importPart }),
      ...(options.elementRegistry === undefined
        ? {}
        : { elementRegistry: options.elementRegistry }),
    });

    wireClose({ desktop, windowHooks: activation.windowHooks });
    installKeybindings({
      desktop,
      ...(options.keyTarget === undefined ? {} : { target: options.keyTarget }),
    });
    serveShellCommands({ desktop, services: activation.services });
    const core = catalog.resolved.composition.core;
    const quarantined =
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

    const coreFailure = description.primary ? quarantined : null;

    if (options.mount !== undefined) {
      await options.mount({ description });
      failure = coreFailure;
    } else {
      const tag = `${core}-outlet`;
      const registry =
        options.elementRegistry?.() ??
        (globalThis as { customElements?: ElementRegistry }).customElements;

      if (coreFailure !== null) {
        failure = coreFailure;
      } else if (registry?.get(tag) === undefined) {
        failure = quarantined ?? {
          bundleId: core,
          message: `Core bundle "${core}" did not define <${tag}>.`,
        };
      } else {
        document.body.replaceChildren(document.createElement(tag));
        failure = null;
      }
    }
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
