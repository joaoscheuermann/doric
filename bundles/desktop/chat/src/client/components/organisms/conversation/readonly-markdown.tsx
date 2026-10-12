import { CodeNode } from '@lexical/code';
import { ListItemNode, ListNode } from '@lexical/list';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { $getRoot, type EditorThemeClasses } from 'lexical';

import { $appendMarkdown } from './nodes/markdown-blocks.js';

/** Read-only detail inside a widget, using the conversation's Markdown and theme. */
export function ReadonlyMarkdown({ text }: { readonly text: string }) {
  const [, context] = useLexicalComposerContext();
  return (
    <ReadonlyMarkdownView text={text} theme={context.getTheme() ?? undefined} />
  );
}

/**
 * The same detail with an explicit theme, for a host with no conversation
 * editor around it (`<chat-readonly-markdown>`, R-9.9).
 */
export function ReadonlyMarkdownView({
  text,
  theme,
}: {
  readonly text: string;
  readonly theme?: EditorThemeClasses;
}) {
  return (
    <LexicalComposer
      key={text}
      initialConfig={{
        namespace: 'delegated-markdown',
        editable: false,
        theme,
        nodes: [
          CodeNode,
          HeadingNode,
          QuoteNode,
          ListNode,
          ListItemNode,
          TableNode,
          TableRowNode,
          TableCellNode,
        ],
        editorState: () =>
          $appendMarkdown($getRoot(), text.trim() || 'No message content.'),
        onError: (error) => {
          throw error;
        },
      }}
    >
      <RichTextPlugin
        contentEditable={
          <ContentEditable className="outline-none" tabIndex={-1} />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
    </LexicalComposer>
  );
}
