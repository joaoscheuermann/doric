// xterm.js, loaded on demand (stage 9 §5.10): a client part may touch the DOM
// at import time only through a custom element class, so the terminal view
// imports the emulator with `import()` when it mounts, once per window.

export type Xterm = typeof import('./xterm-runtime.js');

let loading: Promise<Xterm> | undefined;

export const loadXterm = (): Promise<Xterm> => {
  loading ??= import('./xterm-runtime.js');
  return loading;
};
