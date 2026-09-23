import { $convertFromMarkdownString } from '@lexical/markdown';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { useEffect } from 'react';

import {
  CaretPlugin,
  type DocumentHandlers,
  EditabilityPlugin,
  ReadPlugin,
  WritePlugin,
} from './document-plugins';
import type { CaretEdge, Comment } from './editing';
import {
  documentSyncTag,
  nodes,
  theme,
  transformers,
} from './markdown-document';
import { remendMarkdown } from './remend';

export type DocumentMode = 'read' | 'write';

/** Rewrites the document when the Markdown it represents changes from outside. */
function SyncPlugin({ text }: { readonly text: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.update(
      () => {
        $convertFromMarkdownString(remendMarkdown(text), transformers);
      },
      { tag: documentSyncTag },
    );
  }, [editor, text]);

  return null;
}

export function Document({
  text,
  mode,
  editable,
  focusEdge,
  comments = [],
  handlers = {},
  placeholder,
  resetToken = 0,
  className,
}: {
  readonly text: string;
  readonly mode: DocumentMode;
  readonly editable: boolean;
  readonly focusEdge?: CaretEdge;
  readonly comments?: readonly Comment[];
  readonly handlers?: DocumentHandlers;
  readonly placeholder?: string;
  /** Bump it to re-seed the document from `text`, which is how a draft clears. */
  readonly resetToken?: number;
  readonly className?: string;
}) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: `doric-${mode}`,
        editable: false,
        nodes,
        theme,
        onError: (error: Error) => {
          throw error;
        },
      }}
    >
      {/* Lexical renders the placeholder as a sibling *after* the editable
          surface, so the wrapper is what lets the placeholder sit over the
          editor's first line instead of flowing onto a line of its own. It
          carries `min-w-0` because the wrapper, not the editor, is the layout
          item, and the placeholder wears the prose face so it reads as the text
          the reader is about to type. */}
      <div className="relative min-w-0">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              aria-label={mode === 'read' ? 'Answer' : 'Prompt'}
              aria-readonly={mode === 'read' ? 'true' : undefined}
              className={className}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
          placeholder={
            placeholder === undefined ? null : (
              <p className="pointer-events-none absolute inset-x-0 top-0 font-serif text-sm leading-7 text-muted-foreground/60">
                {placeholder}
              </p>
            )
          }
        />
      </div>
      <SyncPlugin key={resetToken} text={text} />
      <EditabilityPlugin editable={editable} />
      {mode === 'write' ? (
        <WritePlugin handlers={handlers} platform={navigator.platform} />
      ) : (
        <ReadPlugin comments={comments} handlers={handlers} />
      )}
      <CaretPlugin focusEdge={focusEdge} />
    </LexicalComposer>
  );
}
