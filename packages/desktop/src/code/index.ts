// `desktop/ui/code`: the read-only code view and the diff editor the file and
// diff tabs share, with the language a file is read as. Monaco itself is loaded
// with a dynamic import when the first editor mounts, so importing this subpath
// does not load the editor.
export * from './code-view.js';
export * from './diff-editor.js';
export * from './language.js';
