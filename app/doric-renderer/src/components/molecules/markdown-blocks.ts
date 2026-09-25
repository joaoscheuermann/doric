import {
  CommentCardNode,
  CommentFieldNode,
} from '@/components/molecules/comment-nodes';
import { CommentedTextNode } from '@/components/molecules/commented-text-node';
import {
  AgentTurnNode,
  TurnNode,
  UserTurnNode,
} from '@/components/molecules/turn-node';
import { TurnPartNode } from '@/components/molecules/turn-part-node';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from '@lexical/markdown';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import {
  $createParagraphNode,
  type EditorThemeClasses,
  type ElementNode,
  type Klass,
  type LexicalNode,
} from 'lexical';
import remend from 'remend';

/**
 * The markdown a turn's words are written in, and the Lexical side of it: which
 * nodes the document may hold, how each one reads, and the two conversions — a
 * string into blocks, and those blocks back into the string the log stores.
 */

/**
 * Every node type the conversation document may hold: the turn and part nodes the
 * surface renders its own blocks with, the comment's own nodes, and the nodes
 * markdown parses into.
 *
 * `CodeHighlightNode` is deliberately absent: this surface shows code, it does
 * not colour it.
 */
export const conversationNodes: readonly Klass<LexicalNode>[] = [
  TurnNode,
  UserTurnNode,
  AgentTurnNode,
  TurnPartNode,
  CommentedTextNode,
  CommentFieldNode,
  CommentCardNode,
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  LinkNode,
];

/**
 * How every block and run reads. The names are the ones `styles.css` defines, so
 * the prose in a turn is styled in one place instead of by a class per node.
 */
export const markdownTheme: EditorThemeClasses = {
  code: 'doric-code',
  heading: {
    h1: 'doric-h1',
    h2: 'doric-h2',
    h3: 'doric-h3',
    h4: 'doric-h4',
    h5: 'doric-h5',
    h6: 'doric-h6',
  },
  link: 'doric-link',
  list: {
    listitem: 'doric-li',
    nested: { listitem: 'doric-li' },
    ol: 'doric-ol',
    ul: 'doric-ul',
  },
  paragraph: 'doric-paragraph',
  quote: 'doric-quote',
  text: {
    bold: 'doric-bold',
    code: 'doric-inline-code',
    italic: 'doric-italic',
    strikethrough: 'doric-strikethrough',
    underline: 'doric-underline',
  },
};

/**
 * Replaces what a block holds with the blocks `markdown` parses into. An empty
 * string leaves one empty paragraph rather than nothing, so the block can keep a
 * caret: a container with no children has nowhere to put one.
 *
 * `heal` closes the half-written markdown a stream delivers (`**bold` and the
 * like) so an answer renders while it is still arriving; it is off by default,
 * because a tool's payload is data and must reach the document exactly as it is.
 *
 * `keep` names the children this write must not touch — the comment fields and
 * cards that live beside the words rather than in them. They survive the write and
 * are placed again by the caller, because where they belong is stated by the
 * comment, not by the markdown.
 */
export const $setMarkdown = (
  container: ElementNode,
  markdown: string,
  options: {
    readonly heal?: boolean;
    readonly keep?: (node: LexicalNode) => boolean;
  } = {},
): void => {
  const keep = options.keep;
  const kept = container
    .getChildren()
    .filter((child) => keep?.(child) === true);
  container.clear();
  const source =
    options.heal === true && markdown.length > 0 ? remend(markdown) : markdown;
  if (source.length > 0) {
    $convertFromMarkdownString(source, TRANSFORMERS, container);
  }
  if (kept.length > 0) {
    container.append(...kept);
  }
  if (container.getChildrenSize() === 0) {
    container.append($createParagraphNode());
  }
};

/**
 * The markdown a block's children state. It is what a submit sends and what a
 * later render compares against, so the same rule covers both directions.
 */
export const $markdownOf = (node: ElementNode): string =>
  $convertToMarkdownString(TRANSFORMERS, node);
