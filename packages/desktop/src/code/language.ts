/**
 * What the editor calls text it has no grammar for; `plaintext` is Monaco's own
 * id for it, so an unknown file still reads as its own text.
 */
const PLAINTEXT = 'plaintext';

/** The language id each extension this surface knows how to highlight gets. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bash: 'shell',
  cjs: 'javascript',
  css: 'css',
  cts: 'typescript',
  htm: 'html',
  html: 'html',
  js: 'javascript',
  jsx: 'javascript',
  markdown: 'markdown',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  py: 'python',
  rs: 'rust',
  sh: 'shell',
  sql: 'sql',
  svg: 'xml',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
};

/** The last segment of `path`: the file it names, not its chain. */
const fileName = (path: string): string => {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? path : path.slice(separator + 1);
};

/**
 * The language the file view reads `path` as, by its extension alone: a name
 * with no extension, or one this surface has no grammar for, is `plaintext`.
 * JSON is deliberately one of those: Monaco serves it as a language service
 * with a worker of its own, and this surface bundles the editor worker only.
 */
export const fileLanguage = (path: string): string => {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return PLAINTEXT;
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? PLAINTEXT;
};
