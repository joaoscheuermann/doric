/**
 * Styles the markdown the reader types, on the line it is typed in.
 *
 * The prompt stays one editable block holding the text exactly as it was typed:
 * this plugin adds no node, splits none and moves none, so the caret is never
 * disturbed and what a send reads is still the markdown itself. What changes is
 * the `style` of the line's own text node — a line the markdown calls a heading
 * wears a heading's size and weight, a quote its rule, a list item its indent, a
 * fence its surface. The markers stay visible, because the text is never
 * rewritten; only what the line *is* is drawn.
 *
 * It is the prompt's half of the conversation's markdown. The agent's answer can
 * be read into real block nodes, because nothing there is edited; an editable
 * block cannot afford them, so the prompt keeps its shape and wears the style
 * instead. Which kind of line the markdown names is the rule `domain/markdown`
 * owns; what that kind looks like is drawn here, because a text node wears a
 * style and not a class.
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $isTextNode, type LexicalNode, TextNode } from 'lexical';
import { useEffect } from 'react';

import { $isUserPromptNode } from '@/components/organisms/conversation/nodes/user-prompt-node';
import { type MarkdownBlock, markdownBlocks } from '@/domain/markdown';

import { $blockOf } from './blocks';

/** The size a heading of this depth wears, up to the six a heading can be. */
const headingStyles: Readonly<Record<number, string>> = {
  1: 'font-size: 1.25rem; font-weight: 500;',
  2: 'font-size: 1.125rem; font-weight: 500;',
  3: 'font-size: 1rem; font-weight: 500;',
  4: 'font-size: 1rem;',
  5: 'font-size: 0.9rem;',
  6: 'font-size: 0.9rem;',
};

/** The style one line of the prompt wears, from the markdown it is written in. */
const lineStyle = (block: MarkdownBlock | undefined): string => {
  switch (block?.kind) {
    case 'heading':
      return headingStyles[block.depth] ?? '';
    case 'quote':
      return 'border-left: 2px solid var(--border); color: var(--muted-foreground); padding-left: 0.75rem;';
    case 'bullet':
    case 'ordered':
      // The transcript's own list indents each item by the same measure, so a
      // list the reader types reads in the input the way it will read above it.
      return 'padding-left: 1.5rem;';
    case 'code':
      return 'background: var(--muted); border-radius: var(--radius); font-family: var(--font-mono); font-size: 0.85em;';
    default:
      return '';
  }
};

/**
 * Every text node of the line one text node sits in, in source order: the text
 * nodes beside it up to the line breaks that end the line.
 */
const $lineOf = (node: TextNode): readonly TextNode[] => {
  const before: TextNode[] = [];
  const after: TextNode[] = [];

  const walk = (
    step: (current: LexicalNode) => LexicalNode | null,
    into: TextNode[],
  ): void => {
    let current = step(node);
    while ($isTextNode(current)) {
      into.push(current);
      current = step(current);
    }
  };

  walk((current) => current.getPreviousSibling(), before);
  walk((current) => current.getNextSibling(), after);

  return [...before.reverse(), node, ...after];
};

/** The source of the line a text node sits in, which its markdown is read from. */
const $lineSource = (node: TextNode): string =>
  $lineOf(node)
    .map((text) => text.getTextContent())
    .join('');

/**
 * The markdown rules in `domain/markdown` have to see a whole line to read it,
 * so this answers only for a node whose line is the prompt's.
 */
export function MarkdownPromptPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      editor.registerNodeTransform(TextNode, (node) => {
        // Only the prompt's own lines are styled: the answer's text is drawn by
        // the blocks it was read into, and the reader's turns are the log's.
        if (!$isUserPromptNode($blockOf(node))) return;

        const style = lineStyle(markdownBlocks($lineSource(node))[0]);
        if (node.getStyle() !== style) node.setStyle(style);
      }),
    [editor],
  );

  return null;
}
