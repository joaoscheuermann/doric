import {
  $createCommentCardNode,
  $createCommentFieldNode,
  $isCommentCardNode,
  $isCommentFieldNode,
} from '@/components/molecules/comment-nodes';
import {
  $createCommentedTextNode,
  $isCommentedTextNode,
} from '@/components/molecules/commented-text-node';
import type { TurnNode } from '@/components/molecules/turn-node';
import { $isTurnNode } from '@/components/molecules/turn-node';
import { $isTurnPartNode } from '@/components/molecules/turn-part-node';
import { locateQuote, type PromptComment } from '@/domain/comments';
import { collapsed } from '@/domain/markdown';
import {
  $createTextNode,
  ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';

/**
 * The comment side of a turn's content: which spans are commented, the field that
 * edits a comment still being written, and the card that reads one back.
 *
 * All of it is *derived*, never invented here: the turns state which comments an
 * answer carries, and this writes them into the document after the content they
 * belong to. That order is the whole rule — a comment is found in the answer's
 * words, so every write of those words clears the marks with them and this puts
 * them back, which is why a comment survives an answer that is still streaming.
 */

/** Where one of a turn's text nodes sits in the turn's own text. */
type TextSpan = {
  readonly node: TextNode;
  readonly block: ElementNode;
  readonly start: number;
  readonly end: number;
};

/**
 * Whether this child is a comment's own node. A content write keeps these: they
 * live *beside* the words, and where they belong is stated by the comment rather
 * than by the markdown being parsed.
 */
export const $isCommentNode = (node: LexicalNode): boolean =>
  $isCommentFieldNode(node) || $isCommentCardNode(node);

/**
 * The block a text node's words are read as: the deepest ancestor that is a direct
 * child of a turn or of one of its parts. A comment's field sits below the block
 * that holds the end of the span it was taken from, which is what makes a
 * multi-line selection put the field under its last line rather than its first.
 */
const $blockOf = (node: LexicalNode): ElementNode | undefined => {
  let current: LexicalNode | undefined = node;
  while (current !== undefined) {
    const parent: LexicalNode | null = current.getParent();
    if (parent === null) return undefined;
    if ($isBlockContainer(parent)) {
      return current instanceof ElementNode ? current : undefined;
    }
    current = parent;
  }
  return undefined;
};

/** The nodes whose direct children are blocks: a turn, and each of its parts. */
const $isBlockContainer = (node: LexicalNode): boolean =>
  $isTurnNode(node) || $isTurnPartNode(node);

/**
 * A turn's own text, and where each of its text nodes sits in it. Blocks are
 * joined the way a selection reads them, so a quote a person took across two
 * paragraphs is still found.
 */
const $textWithSpans = (
  turn: TurnNode,
): { readonly text: string; readonly spans: readonly TextSpan[] } => {
  let text = '';
  const spans: TextSpan[] = [];
  let block: ElementNode | undefined;
  for (const node of turn.getAllTextNodes()) {
    const owner = $blockOf(node);
    if (owner === undefined) continue;
    if (block !== undefined && owner !== block) text += '\n\n';
    block = owner;
    const start = text.length;
    text += node.getTextContent();
    spans.push({ block: owner, end: text.length, node, start });
  }
  return { spans, text };
};

/** A plain run of words, carrying what a commented run carried. */
const $plainText = (text: string, from: TextNode): TextNode =>
  $createTextNode(text)
    .setFormat(from.getFormat())
    .setStyle(from.getStyle())
    .setDetail(from.getDetail());

/** Every commented span in a turn goes back to being plain words. */
const $clearCommentMarks = (turn: TurnNode): void => {
  for (const node of turn.getAllTextNodes()) {
    if (!$isCommentedTextNode(node)) continue;
    node.replace($plainText(node.getTextContent(), node));
  }
};

/**
 * Marks one run of one text node: the words keep their place, and only the middle
 * of them becomes a commented run. The node itself keeps the head, so a caret
 * standing in these words stays in the node it was in.
 */
const $markRun = (
  node: TextNode,
  start: number,
  stop: number,
  commentId: string,
): void => {
  const text = node.getTextContent();
  const tail = text.slice(stop);
  const mark = $createCommentedTextNode(text.slice(start, stop), commentId);
  mark.setFormat(node.getFormat());
  mark.setStyle(node.getStyle());
  mark.setDetail(node.getDetail());
  node.setTextContent(text.slice(0, start));
  node.insertAfter(mark);
  if (tail.length > 0) {
    mark.insertAfter($plainText(tail, node));
  }
};

/**
 * Marks every run a span covers, and answers with the block the span ends in — the
 * block a field for this comment belongs below.
 */
const $markSpan = (
  spans: readonly TextSpan[],
  from: number,
  to: number,
  commentId: string,
): ElementNode | undefined => {
  let last: ElementNode | undefined;
  for (const span of spans) {
    const start = Math.max(from, span.start);
    const stop = Math.min(to, span.end);
    if (start >= stop) continue;
    $markRun(span.node, start - span.start, stop - span.start, commentId);
    last = span.block;
  }
  return last;
};

/**
 * Puts one comment's field right below the block it belongs to, and gives the
 * caret to a field that did not exist yet: a comment just made is a comment about
 * to be written, and needing a second click to start would be a step nobody asked
 * for.
 */
const $placeField = (block: ElementNode, commentId: string): void => {
  const parent = block.getParent();
  if (parent === null || !(parent instanceof ElementNode)) return;
  let field = parent
    .getChildren()
    .find(
      (child) =>
        $isCommentFieldNode(child) && child.getCommentId() === commentId,
    );
  if (field === undefined) {
    field = $createCommentFieldNode(commentId).setFocused(true);
  }
  block.insertAfter(field);
};

/** Removes the fields of comments that are no longer being written. */
const $dropFields = (turn: TurnNode, pending: ReadonlySet<string>): void => {
  for (const node of turn.getChildren()) {
    if (!$isCommentFieldNode(node)) continue;
    if (!pending.has(node.getCommentId())) node.remove();
  }
  for (const part of turn.getChildren()) {
    if (!$isTurnPartNode(part)) continue;
    for (const node of part.getChildren()) {
      if (!$isCommentFieldNode(node)) continue;
      if (!pending.has(node.getCommentId())) node.remove();
    }
  }
};

/**
 * Writes a turn's comments into it: the marks on the words they were taken from,
 * and a field below the block each still-being-written comment belongs to.
 *
 * `fields` names the comments the person is still writing; the marks cover every
 * comment the turn carries, sent or not, because a comment that travelled with a
 * prompt still says which words it was about.
 */
export const $applyCommentMarks = (
  turn: TurnNode,
  marks: readonly PromptComment[],
  fields: readonly PromptComment[],
): void => {
  $clearCommentMarks(turn);
  const pending = new Set(fields.map((comment) => comment.id));

  for (const mark of marks) {
    // Each comment is found in the turn as it stands now, so two comments on
    // words that overlap both land on the words they were taken from.
    const { spans, text } = $textWithSpans(turn);
    const folded = collapsed(text);
    const at = locateQuote(folded.text, mark.quote);
    if (at === undefined) continue;
    const start = folded.offsets[at.start];
    const last = folded.offsets[at.end - 1];
    if (start === undefined || last === undefined) continue;
    const block = $markSpan(spans, start, last + 1, mark.id);
    if (block === undefined || !pending.has(mark.id)) continue;
    $placeField(block, mark.id);
  }

  // A field whose comment is still being written stays where it is even when its
  // words can no longer be found: the person is typing in it.
  $dropFields(turn, pending);
};

/**
 * Writes the comments a person's own turn carried: one card above their words, in
 * the order the prompt listed them. A sent comment is read, not edited — the place
 * it was written is the answer it was taken from.
 */
export const $applyCommentCards = (
  turn: TurnNode,
  comments: readonly PromptComment[],
): void => {
  for (const child of turn.getChildren()) {
    if ($isCommentCardNode(child)) child.remove();
  }
  if (comments.length === 0) return;
  turn.splice(
    0,
    0,
    comments.map((comment) =>
      $createCommentCardNode(comment.quote, comment.body),
    ),
  );
};

/**
 * Everything a turn's marks and fields depend on: which comments it shows, the
 * spans they mean, and which of them are still being written.
 */
export const marksSignature = (
  marks: readonly PromptComment[],
  fields: readonly PromptComment[],
): string =>
  `${marks
    .map((comment) => `${comment.id}:${comment.quote}`)
    .join('|')}#${fields.map((comment) => comment.id).join('|')}`;

/** Everything a turn's cards depend on: the comment as it was sent. */
export const cardsSignature = (comments: readonly PromptComment[]): string =>
  comments
    .map((comment) => `${comment.id}:${comment.quote}:${comment.body}`)
    .join('|');
