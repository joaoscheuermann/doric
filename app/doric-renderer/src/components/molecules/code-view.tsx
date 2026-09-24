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

import { defineCodeViewTheme } from '@/components/molecules/code-view-theme';
import { editor } from 'monaco-editor/editor/editor.api.js';
import { useEffect, useRef } from 'react';

/**
 * The editor worker, and only it. The view is read-only, so it never asks for a
 * completion, a diagnostic or a hover, which is what a language service worker
 * exists for; the one worker the editor needs is the module next to the editor
 * itself, emitted as its own same-origin file, which the packaged policy's
 * `script-src 'self'` already allows.
 */
self.MonacoEnvironment = {
  getWorker: () =>
    new Worker(
      new URL('monaco-editor/editor/editor.worker.js', import.meta.url),
    ),
};

type CodeViewProps = {
  /** A Monaco language id, which `domain/files.ts` names from the path. */
  readonly language: string;
  readonly value: string;
};

/**
 * The open file's text as the editor renders it: read-only, monospace, and
 * colored by the grammar for the language it was given.
 *
 * One editor serves whatever is mounted here, and one mounted file is one
 * editor: the editor is created with the first text and disposed when the
 * surface unmounts, and later text and language are applied to the model it
 * already holds, because recreating an editor for every read would leak the
 * one before it. The font is the mono stack the CSS resolves — `--font-mono`,
 * which Tailwind applies to the container — so a change to the palette's font
 * reaches the editor too.
 *
 * The palette and the theme it is painted with are the app's own: see
 * `./code-view-theme`, which reads `src/styles.css` off the document and
 * defines the theme for the mode the document states.
 */
export function CodeView({ language, value }: CodeViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<editor.IStandaloneCodeEditor | undefined>(undefined);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const theme = defineCodeViewTheme();
    const created = editor.create(element, {
      automaticLayout: true,
      domReadOnly: true,
      fontFamily: getComputedStyle(element).fontFamily,
      // The size and the vertical padding the `<pre>` this replaced had.
      fontSize: 12,
      // Our scroll views carry no strip beside them, so the overview ruler and
      // the border it draws would read as a second, wrong scrollbar.
      hideCursorInOverviewRuler: true,
      language,
      minimap: { enabled: false },
      overviewRulerBorder: false,
      overviewRulerLanes: 0,
      padding: { top: 12, bottom: 12 },
      readOnly: true,
      renderLineHighlight: 'none',
      scrollBeyondLastLine: false,
      scrollbar: {
        // A wheel over a panel at its end belongs to whatever contains it.
        alwaysConsumeMouseWheel: false,
        horizontal: 'auto',
        // `w-2.5`: the lane our `ScrollArea` gives its thumb, and a shape CSS
        // rounds off (see the slider rule in `src/styles.css`).
        horizontalScrollbarSize: 10,
        // The band that appears at the top once the text is scrolled, and the
        // shadows the scrollbars themselves cast: nothing in the app draws
        // either, so both are off.
        useShadows: false,
        vertical: 'auto',
        verticalScrollbarSize: 10,
      },
      // The nested scopes it sticks to the top draw a border and a shadow there
      // that no other surface of the app has.
      stickyScroll: { enabled: false },
      // The app states its own theme on the document before React renders, and
      // nothing switches it afterwards, so the editor reads it once and the
      // theme defined for that mode is the one it uses.
      theme,
      value,
      wordWrap: 'off',
    });
    view.current = created;
    return () => {
      view.current = undefined;
      created.dispose();
    };
    // The editor outlives a text change on purpose: the effect below applies it.
  }, []);

  useEffect(() => {
    const model = view.current?.getModel();
    if (model === null || model === undefined) return;
    editor.setModelLanguage(model, language);
    if (model.getValue() !== value) model.setValue(value);
  }, [language, value]);

  return (
    <div
      ref={container}
      data-slot="code-view"
      className="min-h-0 flex-1 font-mono"
    />
  );
}
