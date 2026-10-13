import type { editor } from 'monaco-editor/editor/editor.api.js';
import { useEffect, useRef, useState } from 'react';

import { loadMonaco, type Monaco } from './monaco.js';

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
  // The editor is built once, with the language and text of its first render;
  // the effect below applies every later read. Keeping that first pair in a ref
  // is what lets the create effect stay free of the props it only reads once.
  // Monaco arrives with a dynamic import (`./monaco.js`), so the editor is
  // built from the text of the render current when it lands.
  const initial = useRef({ language, value });
  initial.current =
    view.current === undefined ? { language, value } : initial.current;
  const monaco = useRef<Monaco | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    let cancelled = false;
    let created: editor.IStandaloneCodeEditor | undefined;
    void loadMonaco().then((loaded) => {
      if (cancelled) return;
      monaco.current = loaded;
      const theme = loaded.defineCodeViewTheme();
      created = loaded.editor.create(element, {
        automaticLayout: true,
        domReadOnly: true,
        fontFamily: getComputedStyle(element).fontFamily,
        // The size and the vertical padding the `<pre>` this replaced had.
        fontSize: 12,
        // Our scroll views carry no strip beside them, so the overview ruler and
        // the border it draws would read as a second, wrong scrollbar.
        hideCursorInOverviewRuler: true,
        language: initial.current.language,
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
        value: initial.current.value,
        wordWrap: 'off',
      });
      view.current = created;
      setReady(true);
    });
    return () => {
      cancelled = true;
      view.current = undefined;
      created?.dispose();
    };
    // The editor outlives a text change on purpose: the effect below applies it.
  }, []);

  useEffect(() => {
    if (!ready) return;
    const current = view.current;
    const model = current?.getModel();
    const loaded = monaco.current;
    if (model === null || model === undefined || loaded === undefined) return;
    loaded.editor.setModelLanguage(model, language);
    if (model.getValue() !== value) {
      const position = current?.saveViewState();
      model.setValue(value);
      if (position) current?.restoreViewState(position);
    }
  }, [language, value, ready]);

  useEffect(() => {
    if (!ready) return;
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const loaded = monaco.current;
      if (loaded) loaded.editor.setTheme(loaded.defineCodeViewTheme());
    };
    scheme.addEventListener('change', update);
    return () => scheme.removeEventListener('change', update);
  }, [ready]);

  return (
    <div
      ref={container}
      data-slot="code-view"
      className="min-h-0 flex-1 font-mono"
    />
  );
}
