/**
 * Keeps the conversation's blocks: a deletion may empty one, never remove one.
 *
 * A block is removed only through the deletion commands — a range that spans
 * blocks is joined by `$getBlockMergeTargets`, which splices the later block's
 * children into the earlier one and drops it. There is no hook inside that, so
 * this plugin answers the commands above the editor's own handlers
 * (`@lexical/rich-text` registers them all at `COMMAND_PRIORITY_EDITOR`) and
 * takes over exactly when the default would remove a protected block:
 *
 * - a range inside one block is left to the default;
 * - a range across blocks removes the text it covers block by block, emptying
 *   the blocks rather than joining them, and leaving a read-only one alone;
 * - a caret at a block's edge deletes nothing — the edge is not deletable;
 * - a node selection empties the blocks it covers.
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createPoint,
  $createRangeSelection,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  type LexicalNode,
  mergeRegister,
  type NodeSelection,
  type PointType,
  type RangeSelection,
  REMOVE_TEXT_COMMAND,
} from 'lexical';
import { useEffect } from 'react';

import {
  $atBlockEnd,
  $atBlockStart,
  $blockOf,
  $selectedBlocks,
} from './blocks';

type UndeletableBlocksProps = {
  /** Whether a block of this node type survives a deletion. */
  readonly isUndeletable: (nodeType: string) => boolean;
  /** Whether a block of this node type is read-only, so a deletion passes it by. */
  readonly isReadOnly: (nodeType: string) => boolean;
};

/** The point before everything in a block. */
const $startOf = (block: LexicalNode): PointType =>
  $createPoint(block.getKey(), 0, 'element');

/** The point after everything in a block. */
const $endOf = (block: LexicalNode): PointType =>
  $createPoint(
    block.getKey(),
    $isElementNode(block) ? block.getChildrenSize() : 0,
    'element',
  );

/**
 * Removes the text between two points of one block, keeping the block. A range
 * that stays inside a block never reaches the join at the heart of
 * `$removeTextFromCaretRange` — that needs two distinct blocks — so the block
 * survives it.
 */
const $removeBetween = (from: PointType, to: PointType): void => {
  const selection = $createRangeSelection();
  selection.anchor.set(from.key, from.offset, from.type);
  selection.focus.set(to.key, to.offset, to.type);
  $setSelection(selection);
  selection.removeText();
};

/**
 * Removes the text a selection covers, block by block: the blocks it spans are
 * emptied rather than joined, and a read-only one keeps its text. The caret ends
 * where the blocks would have joined, at the end of the first one.
 */
const $removeAcrossBlocks = (
  selection: RangeSelection,
  isReadOnly: (nodeType: string) => boolean,
): void => {
  const blocks = $selectedBlocks(selection);
  if (blocks.length < 2) return;
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const anchorBlock = $blockOf(selection.anchor.getNode());
  const forward = anchorBlock !== null && anchorBlock.is(first);
  const start = forward ? selection.anchor : selection.focus;
  const end = forward ? selection.focus : selection.anchor;

  // Work from the end of the document back, so the points taken from the
  // selection stay valid as the blocks before them change.
  if (!isReadOnly(last.getType())) $removeBetween($startOf(last), end);

  for (let index = blocks.length - 2; index > 0; index--) {
    const block = blocks[index];
    if (isReadOnly(block.getType())) continue;
    if ($isElementNode(block)) block.clear();
  }

  if (!isReadOnly(first.getType())) $removeBetween(start, $endOf(first));

  if ($isElementNode(first)) first.selectEnd();
};

/** Empties the blocks a node selection covers, leaving each block in place. */
const $emptySelectedBlocks = (
  selection: NodeSelection,
  isReadOnly: (nodeType: string) => boolean,
): void => {
  const blocks = $selectedBlocks(selection);
  for (const block of blocks) {
    if (isReadOnly(block.getType())) continue;
    if ($isElementNode(block)) block.clear();
  }
  const first = blocks[0];
  if (first !== undefined && $isElementNode(first)) first.selectEnd();
};

/**
 * Runs the deletion this plugin decides on, or hands it back to the editor.
 * `isBackward` is undefined for a command that has no direction.
 */
const $handleDeletion = (
  isBackward: boolean | undefined,
  isUndeletable: (nodeType: string) => boolean,
  isReadOnly: (nodeType: string) => boolean,
): boolean => {
  const selection = $getSelection();

  if ($isNodeSelection(selection)) {
    if (!selection.getNodes().some((node) => isUndeletable(node.getType()))) {
      return false;
    }
    $emptySelectedBlocks(selection, isReadOnly);
    return true;
  }

  if (!$isRangeSelection(selection)) return false;

  if (selection.isCollapsed()) {
    if (isBackward === undefined) return false;
    const block = $blockOf(selection.anchor.getNode());
    if (block === null) return false;
    if (isBackward) {
      // Backspace would join this block into the one before it.
      return isUndeletable(block.getType()) && $atBlockStart(selection, block);
    }
    // Delete would join the block after this one into it, dropping that one.
    const next = block.getNextSibling();
    return (
      next !== null &&
      isUndeletable(next.getType()) &&
      $atBlockEnd(selection, block)
    );
  }

  const blocks = $selectedBlocks(selection);
  if (blocks.length < 2) return false;
  if (!blocks.some((block) => isUndeletable(block.getType()))) return false;
  $removeAcrossBlocks(selection, isReadOnly);
  return true;
};

export function UndeletableBlocksPlugin({
  isUndeletable,
  isReadOnly,
}: UndeletableBlocksProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const handler = (isBackward: boolean): boolean =>
      $handleDeletion(isBackward, isUndeletable, isReadOnly);

    return mergeRegister(
      editor.registerCommand(
        DELETE_CHARACTER_COMMAND,
        handler,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        DELETE_WORD_COMMAND,
        handler,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        DELETE_LINE_COMMAND,
        handler,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        REMOVE_TEXT_COMMAND,
        () => $handleDeletion(undefined, isUndeletable, isReadOnly),
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor, isUndeletable, isReadOnly]);

  return null;
}
