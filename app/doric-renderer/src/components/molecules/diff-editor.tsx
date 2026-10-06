// Reuse the code view's language registration and same-origin editor worker.
import '@/components/molecules/code-view';

import { editor } from 'monaco-editor/editor/editor.api.js';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { defineCodeViewTheme } from '@/components/molecules/code-view-theme';
import { changedLineCounts } from '@/domain/file-diff';

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
  toolbar,
  footer,
}: {
  readonly original: string;
  readonly modified: string;
  readonly language: string;
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

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const originalModel = editor.createModel(original, language);
    const modifiedModel = editor.createModel(modified, language);
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
      theme: defineCodeViewTheme(),
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
    return () => {
      view.current = undefined;
      changed.dispose();
      created.setModel(null);
      // Monaco releases its previous view-model reference asynchronously. Cancel
      // its worker read now, before releasing the text models it still reads.
      diffModel.dispose();
      created.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, []);

  useEffect(() => {
    const current = view.current;
    const models = current?.getModel();
    if (!current || !models) return;
    const position = current.saveViewState();
    editor.setModelLanguage(models.original, language);
    editor.setModelLanguage(models.modified, language);
    if (models.original.getValue() !== original)
      models.original.setValue(original);
    if (models.modified.getValue() !== modified)
      models.modified.setValue(modified);
    if (position) current.restoreViewState(position);
  }, [language, original, modified]);

  useEffect(() => {
    const current = view.current;
    const element = container.current;
    if (!current || !element) return;
    const updateLayout = () => {
      const position = current.saveViewState();
      current.updateOptions({
        renderSideBySide: layout === 'split',
        // Compact mode removes the original-number gutter in unified view.
        // Disable it in wide split views so Monaco honors the chosen layout
        // even for simple additions/deletions that it would otherwise inline.
        compactMode: layout === 'unified' || element.clientWidth <= 700,
      });
      if (position) current.restoreViewState(position);
    };
    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout]);

  return (
    <>
      {toolbar({
        counts,
        layout,
        onLayout: setLayout,
        onNavigate: (direction) => view.current?.goToDiff(direction),
      })}
      <div
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
