import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown';
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import type { LexicalEditor } from 'lexical';

import { CommentNode } from './comment-node';

/** The node set our Markdown subset needs: headings, quotes, lists, code, links. */
export const nodes = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
  HorizontalRuleNode,
  CommentNode,
];

/**
 * Only the transformers whose nodes we register. A Markdown table or image in an
 * answer therefore lands as plain text instead of making the import fail, and
 * adding a node later brings its transformer back by itself.
 */
const supportedNodes = new Set<unknown>(nodes);
export const transformers = TRANSFORMERS.filter((transformer) =>
  'dependencies' in transformer
    ? transformer.dependencies.every((node) => supportedNodes.has(node))
    : true,
);

/**
 * Our own document writes carry this tag, so the update listener can tell them
 * apart from a keystroke: only a keystroke makes a node dirty.
 */
export const documentSyncTag = 'doric-document-sync';

export const theme = {
  paragraph: 'text-sm leading-7',
  heading: {
    h1: 'text-lg font-semibold',
    h2: 'text-base font-semibold',
    h3: 'text-sm font-semibold',
    h4: 'text-sm font-semibold',
    h5: 'text-sm font-semibold',
    h6: 'text-sm font-semibold',
  },
  quote: 'border-l-2 border-border pl-3 text-muted-foreground',
  list: {
    ul: 'list-disc pl-5',
    ol: 'list-decimal pl-5',
    listitem: 'text-sm leading-7',
  },
  link: 'underline',
  text: {
    bold: 'font-bold',
    italic: 'italic',
    strikethrough: 'line-through',
    code: 'font-mono text-xs',
  },
  code: 'block overflow-x-auto rounded-sm bg-secondary/40 px-2 py-1.5 font-mono text-xs leading-5',
};

/** The Markdown a document currently holds. */
export const markdownOf = (editor: LexicalEditor): string =>
  editor.read(() => $convertToMarkdownString(transformers));
