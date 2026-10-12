// The sandboxed preload (stage 9 cut-over): the window's one namespace is
// `window.doric.desktop`, desktop-client's protocol over the two platform
// channels. Every host or desktop call is a contract call that main's
// dispatcher routes; the semantic Project, Thread, configuration, terminal,
// connection and notification namespaces of the legacy renderer are gone.

import { contextBridge, ipcRenderer } from 'electron';

import { createDesktopApi, type MetaDocument } from './desktop';

/** The platform API; the preload runs before the shell document parses. */
const desktop = createDesktopApi(
  ipcRenderer,
  () => (globalThis as { document?: MetaDocument }).document,
);

contextBridge.exposeInMainWorld('doric', { desktop: desktop.api });
