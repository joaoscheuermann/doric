// The window platform of the desktop: bootstrap, client activation and the
// window <-> main protocol. No React, no layout, no product code; bundles
// never import it.

export {
  activateClientBundles,
  type ClientActivation,
  type ImportPart,
  WindowDirectory,
} from './activate.js';
export { type BootstrapOptions, bootstrapWindow } from './bootstrap.js';
export {
  bridgeError,
  remoteContractRecord,
  shellCall,
  shellStream,
  withoutWindowKey,
} from './bridge.js';
export { provideBrowser } from './browser.js';
export { applyChrome } from './chrome.js';
export { answerClose, wireClose } from './close.js';
export { serveShellCommands } from './commands.js';
export { provideConnection } from './connection.js';
export { type ElementRegistry, provideElements } from './elements.js';
export {
  installKeybindings,
  matchesChord,
  parseAccelerator,
} from './keybindings.js';
export { provideClientPlatform, WindowDiagnostics } from './platform.js';
export * from './protocol.js';
export { insertBundleStyles } from './styles.js';
