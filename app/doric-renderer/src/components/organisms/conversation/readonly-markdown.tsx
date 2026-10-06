import { CodeNode } from '@lexical/code';
import { ListItemNode, ListNode } from '@lexical/list';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { $getRoot } from 'lexical';

import { $appendMarkdown } from '@/components/organisms/conversation/nodes/markdown-blocks';

/** Read-only detail inside a widget, using the conversation's Markdown and theme. */
export function ReadonlyMarkdown({ text }: { readonly text: string }) {
  const [, context] = useLexicalComposerContext();
  return (
    <LexicalComposer
      key={text}
      initialConfig={{
        namespace: 'delegated-markdown',
        editable: false,
        theme: context.getTheme() ?? undefined,
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
