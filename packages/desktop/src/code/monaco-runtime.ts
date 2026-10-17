// Monaco itself, loaded on demand: the editors import this module with
// `import()` when they mount, so a window that never opens a file or diff tab
// never loads it. It registers the languages and the codicon font, points the
// editor worker at `workers/editor.worker.js` next to `desktop/ui`'s own files
// under `doric://app/platform/`, and hands the editor API and the app's theme to
// the code and diff views.
import 'monaco-editor/features/codicon/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/rust/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/sql/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';

import { editor } from 'monaco-editor/editor/editor.api.js';

import { defineCodeViewTheme } from './code-view-theme.js';

/**
 * The editor worker, and only it. The view is read-only, so it never asks for a
 * completion, a diagnostic or a hover, which is what a language service worker
 * exists for; the one worker the editor needs is the module next to the editor
 * itself, emitted as its own same-origin file (`workers/` beside the platform's
 * `desktop/ui` files; `import.meta.url` is this chunk's URL in that folder), which the packaged policy's
 * `script-src 'self'` already allows.
 */
self.MonacoEnvironment = {
  getWorker: () =>
    new Worker(new URL('./workers/editor.worker.js', import.meta.url), {
      type: 'module',
    }),
};

export { defineCodeViewTheme, editor };
