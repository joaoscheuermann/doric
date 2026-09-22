import type { Descendant } from 'slate';

export type MarkdownLine = {
  readonly type: 'line';
  children: { text: string }[];
};

export const markdownValue = (markdown: string): MarkdownLine[] =>
  markdown.split('\n').map((text) => ({
    type: 'line',
    children: [{ text }],
  }));

export const markdownFromValue = (value: readonly Descendant[]): string =>
  value
    .map((node) =>
      'children' in node
        ? node.children
            .map((child) => ('text' in child ? child.text : ''))
            .join('')
        : '',
    )
    .join('\n');
