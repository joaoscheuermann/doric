/**
 * Where a selection sits among the conversation's blocks.
 *
 * A block is a child of the editor's root — one turn or the prompt — and the
 * block plugins work in those terms: a deletion is held to the blocks it spans,
 * and a rule about a kind of block is a rule about the type its node reports.
 */
import {
  $getRoot,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isRootNode,
  type LexicalNode,
  type NodeSelection,
  type RangeSelection,
} from 'lexical';

/** The block a node sits in, or null when it is detached from the root. */
export const $blockOf = (node: LexicalNode): LexicalNode | null => {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (parent === null) return null;
    if ($isRootNode(parent)) return current;
    current = parent;
  }
};

/** Where a block sits among the root's children, or -1 when it is not one. */
export const $blockIndex = (block: LexicalNode): number =>
  $getRoot()
    .getChildren()
    .findIndex((child) => child.is(block));

/** Every block a selection covers, in document order. */
export const $selectedBlocks = (
  selection: RangeSelection | NodeSelection,
): LexicalNode[] => {
  const blocks: LexicalNode[] = [];
  const collect = (block: LexicalNode | null): void => {
    if (block === null) return;
    if (blocks.some((seen) => seen.is(block))) return;
    blocks.push(block);
  };

  if ($isNodeSelection(selection)) {
    for (const node of selection.getNodes()) collect($blockOf(node));
  } else if ($isRangeSelection(selection)) {
    const anchor = $blockOf(selection.anchor.getNode());
    const focus = $blockOf(selection.focus.getNode());
    if (anchor === null || focus === null) return [];
    const anchorIndex = $blockIndex(anchor);
    const focusIndex = $blockIndex(focus);
    if (anchorIndex === -1 || focusIndex === -1) return [];
    const children = $getRoot().getChildren();
    for (const block of children.slice(
      Math.min(anchorIndex, focusIndex),
      Math.max(anchorIndex, focusIndex) + 1,
    )) {
      collect(block);
    }
  }

  return blocks.sort((left, right) => $blockIndex(left) - $blockIndex(right));
};

/** Whether a collapsed caret sits before everything in its block. */
export const $atBlockStart = (
  selection: RangeSelection,
  block: LexicalNode,
): boolean => {
  const point = selection.anchor;
  if (point.type === 'element') {
    return point.getNode().is(block) && point.offset === 0;
  }
  return (
    point.offset === 0 &&
    $isElementNode(block) &&
    (block.getFirstDescendant()?.is(point.getNode()) ?? false)
  );
};

/** Whether a collapsed caret sits after everything in its block. */
export const $atBlockEnd = (
  selection: RangeSelection,
  block: LexicalNode,
): boolean => {
  const point = selection.focus;
  if (!point.getNode().isAttached() || !block.isAttached()) return false;
  if (point.type === 'element') {
    return (
      point.getNode().is(block) &&
      $isElementNode(block) &&
      point.offset === block.getChildrenSize()
    );
  }
  return (
    $isElementNode(block) &&
    point.offset === point.getNode().getTextContentSize() &&
    (block.getLastDescendant()?.is(point.getNode()) ?? false)
  );
};
