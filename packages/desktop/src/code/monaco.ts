// The one way the editors reach Monaco: a dynamic import of
// `./monaco-runtime.js`, made once per window when the first editor mounts.

export type Monaco = typeof import('./monaco-runtime.js');

let loading: Promise<Monaco> | undefined;

export const loadMonaco = (): Promise<Monaco> => {
  loading ??= import('./monaco-runtime.js');
  return loading;
};
