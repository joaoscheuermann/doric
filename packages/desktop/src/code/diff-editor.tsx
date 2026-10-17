// The code view's Monaco module: its language registration and same-origin
// editor worker, loaded with a dynamic import when the editor mounts.

import type { editor } from 'monaco-editor/editor/editor.api.js';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { DiffTokens } from './code-view-theme.js';
import { changedLineCounts } from './diff-counts.js';
import { loadMonaco, type Monaco } from './monaco.js';

export type DiffControls = {
  readonly counts:
    | { readonly added: number; readonly removed: number }
    | undefined;
  readonly layout: string;
  readonly onLayout: (value: string) => void;
  readonly onNavigate: (direction: 'previous' | 'next') => void;
};

/** The same editor/models survive refresh and display-mode changes. */
export function DiffEditor({
  original,
  modified,
  language,
  diffTokens,
  toolbar,
  footer,
}: {
  readonly original: string;
  readonly modified: string;
  readonly language: string;
  /** The palette tokens of the added and removed lines (the caller's colours). */
  readonly diffTokens: DiffTokens;
  readonly toolbar: (controls: DiffControls) => ReactNode;
  readonly footer: (controls: DiffControls) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<editor.IStandaloneDiffEditor | undefined>(undefined);
  const [layout, setLayout] = useState('unified');
  const [computedCounts, setCounts] = useState<{
    added: number;
    removed: number;
  }>();
  // Equal contents need no worker result, including a rename with no text edit.
  const counts =
    original === modified ? { added: 0, removed: 0 } : computedCounts;

  // The diff editor is built once, with the text of its first render; the
  // effect below applies every later read. Keeping that first triple in a ref
  // is what lets the create effect stay free of the props it only reads once.
  // Monaco arrives with a dynamic import (`./monaco.js`), so the editor is
  // built from the text of the render current when it lands.
  const initial = useRef({ language, original, modified, diffTokens });
  initial.current =
    view.current === undefined
      ? { language, original, modified, diffTokens }
      : initial.current;
  const monaco = useRef<Monaco | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    void loadMonaco().then((loaded) => {
      if (cancelled) return;
      monaco.current = loaded;
      const { editor } = loaded;
      const originalModel = editor.createModel(
        initial.current.original,
        initial.current.language,
      );
      const modifiedModel = editor.createModel(
        initial.current.modified,
        initial.current.language,
      );
      const created = editor.createDiffEditor(element, {
        automaticLayout: true,
        readOnly: true,
        originalEditable: false,
        domReadOnly: true,
        renderSideBySide: false,
        compactMode: true,
        useInlineViewWhenSpaceIsLimited: true,
        renderSideBySideInlineBreakpoint: 700,
        renderIndicators: true,
        renderMarginRevertIcon: false,
        renderOverviewRuler: false,
        enableSplitViewResizing: true,
        ignoreTrimWhitespace: false,
        fontFamily: getComputedStyle(element).fontFamily,
        fontSize: 12,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        stickyScroll: { enabled: false },
        theme: loaded.defineCodeViewTheme(initial.current.diffTokens),
      });
      const changed = created.onDidUpdateDiff(() => {
        const lines = created.getLineChanges();
        setCounts(
          lines === null
            ? undefined
            : changedLineCounts(
                lines,
                originalModel.getValue(),
                modifiedModel.getValue(),
              ),
        );
      });
      const diffModel = created.createViewModel({
        original: originalModel,
        modified: modifiedModel,
      });
      created.setModel(diffModel);
      view.current = created;
      setReady(true);
      release = () => {
        changed.dispose();
        created.setModel(null);
        // Monaco releases its previous view-model reference asynchronously. Cancel
        // its worker read now, before releasing the text models it still reads.
        diffModel.dispose();
        created.dispose();
        originalModel.dispose();
        modifiedModel.dispose();
      };
    });
    return () => {
      cancelled = true;
      view.current = undefined;
      release?.();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const current = view.current;
    const models = current?.getModel();
    const loaded = monaco.current;
    if (!current || !models || !loaded) return;
    const position = current.saveViewState();
    loaded.editor.setModelLanguage(models.original, language);
    loaded.editor.setModelLanguage(models.modified, language);
    if (models.original.getValue() !== original)
      models.original.setValue(original);
    if (models.modified.getValue() !== modified)
      models.modified.setValue(modified);
    if (position) current.restoreViewState(position);
  }, [language, original, modified, ready]);

  useEffect(() => {
    if (!ready) return;
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const loaded = monaco.current;
      if (loaded)
        loaded.editor.setTheme(loaded.defineCodeViewTheme(diffTokens));
    };
    scheme.addEventListener('change', update);
    return () => scheme.removeEventListener('change', update);
  }, [ready, diffTokens]);

  useEffect(() => {
    if (!ready) return;
    const current = view.current;
    const element = container.current;
    if (!current || !element) return;
    // Monaco's `automaticLayout` already follows the size; a resize only
    // matters here when it crosses the split breakpoint, so a drag does not
    // reapply the options and the view state on every frame.
    let applied: boolean | undefined;
    const updateLayout = () => {
      // Compact mode removes the original-number gutter in unified view.
      // Disable it in wide split views so Monaco honors the chosen layout
      // even for simple additions/deletions that it would otherwise inline.
      const compactMode = layout === 'unified' || element.clientWidth <= 700;
      if (compactMode === applied) return;
      applied = compactMode;
      const position = current.saveViewState();
      current.updateOptions({
        renderSideBySide: layout === 'split',
        compactMode,
      });
      if (position) current.restoreViewState(position);
    };
    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout, ready]);

  return (
    <>
      {toolbar({
        counts,
        layout,
        onLayout: setLayout,
        onNavigate: (direction) => view.current?.goToDiff(direction),
      })}
      <section
        ref={container}
        className="min-h-0 flex-1 font-mono"
        aria-label="File comparison"
      />
      {footer({
        counts,
        layout,
        onLayout: setLayout,
        onNavigate: (direction) => view.current?.goToDiff(direction),
      })}
    </>
  );
}
