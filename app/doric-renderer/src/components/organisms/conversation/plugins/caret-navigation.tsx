/**
 * The caret's way through the conversation's blocks.
 *
 * The rules — which blocks are stops, which are furniture, where the caret goes
 * next and what Enter does there — live in `@/domain/caret-navigation`. This
 * plugin applies them to the editor's keys and clicks:
 *
 * - an author line is furniture, so a step whose next block is one continues to
 *   the caret's next stop instead — from the block before it to the block after
 *   it — and a click on the line takes no caret at all;
 * - a thinking run, a tool call and an activity summary are one stop each: the
 *   caret focuses them as a whole, and one arrow press in any direction leaves
 *   them for the adjacent block, past any furniture between;
 * - Enter on a focused widget opens or closes it. Every other Enter is the
 *   editor's own: a line in the prompt, and Cmd/Ctrl+Enter to send.
 *
 * DOM measurement stays here: whether an up or down would leave its block is a
 * question about visual lines, which only the browser can answer.
 */
import { $isActivityTurnNode } from '@/components/organisms/conversation/nodes/activity-turn-node';
import { $isThinkingTurnNode } from '@/components/organisms/conversation/nodes/thinking-turn-node';
import { $isToolTurnNode } from '@/components/organisms/conversation/nodes/tool-turn-node';
import { $isTurnAuthorNode } from '@/components/organisms/conversation/nodes/turn-author-node';
import {
  caretKind,
  type Direction,
  enterAction,
  nextStop,
} from '@/domain/caret-navigation';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createNodeSelection,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $getSelection,
  $hasAncestor,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isRootNode,
  $isTextNode,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  getComposedEventTarget,
  getDOMSelection,
  isDOMNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
} from 'lexical';
import { useEffect } from 'react';

import { $atBlockEnd, $atBlockStart, $blockOf } from './blocks';

/** Put the caret on one stop: a widget as a whole, a text block at its edge. */
const $landOn = (block: LexicalNode, direction: Direction): void => {
  // A block that is not an element — a decorator this vocabulary does not
  // know — still stops as a unit rather than opening to the caret.
  if (caretKind(block.getType()) === 'widget' || !$isElementNode(block)) {
    const nodeSelection = $createNodeSelection();
    nodeSelection.add(block.getKey());
    $setSelection(nodeSelection);
    return;
  }
  if (direction === 'next') {
    const first = block.getFirstDescendant();
    if ($isTextNode(first)) first.select(0, 0);
    else block.select(0, 0);
  } else {
    const last = block.getLastDescendant();
    if ($isTextNode(last)) {
      last.select(last.getTextContentSize(), last.getTextContentSize());
    } else {
      block.select(block.getChildrenSize(), block.getChildrenSize());
    }
  }
};

/**
 * Whether one line of movement leaves the caret's block: a caret on the block's
 * first or last visual line leaves it, one in the middle of wrapped text stays.
 * The browser answers where the line would land, and the DOM selection is put
 * back before anything moves. An empty block is left without asking — a line
 * move always escapes one.
 */
const $lineLeavesBlock = (
  editor: LexicalEditor,
  block: LexicalNode,
  direction: Direction,
): boolean => {
  if ($isElementNode(block) && block.getTextContentSize() === 0) return true;
  const rootElement = editor.getRootElement();
  if (rootElement === null) return false;
  const domSelection = getDOMSelection(rootElement.ownerDocument.defaultView);
  if (domSelection === null || domSelection.rangeCount === 0) return false;
  const savedAnchorNode = domSelection.anchorNode;
  const savedAnchorOffset = domSelection.anchorOffset;
  const savedFocusNode = domSelection.focusNode;
  const savedFocusOffset = domSelection.focusOffset;
  domSelection.modify(
    'move',
    direction === 'previous' ? 'backward' : 'forward',
    'line',
  );
  const newAnchorNode = domSelection.anchorNode;
  const newAnchorOffset = domSelection.anchorOffset;
  const restore = (): void => {
    if (savedAnchorNode !== null && savedFocusNode !== null) {
      domSelection.setBaseAndExtent(
        savedAnchorNode,
        savedAnchorOffset,
        savedFocusNode,
        savedFocusOffset,
      );
    }
  };
  if (newAnchorNode === null) {
    restore();
    return false;
  }
  const movedNode = $getNearestNodeFromDOMNode(newAnchorNode);
  // Firefox stays in place when the move hits the top of a block, so no
  // movement is the block's edge.
  const didNotMove =
    newAnchorNode === savedAnchorNode && newAnchorOffset === savedAnchorOffset;
  restore();
  if (movedNode === null) return false;
  return didNotMove || !(movedNode.is(block) || $hasAncestor(movedNode, block));
};

/** The root's children as the blocks the caret walks, in their types. */
const $blockTypes = (): string[] =>
  $getRoot()
    .getChildren()
    .map((child) => child.getType());

/**
 * One arrow press. Handled exactly when it would land on furniture or leave a
 * focused widget; every other press is the editor's own movement.
 */
const $handleArrow = (
  editor: LexicalEditor,
  direction: Direction,
  byLine: boolean,
  event: KeyboardEvent,
): boolean => {
  if (event.shiftKey) return false;
  const selection = $getSelection();
  const children = $getRoot().getChildren();
  const types = $blockTypes();
  const step = direction === 'next' ? 1 : -1;

  if ($isNodeSelection(selection)) {
    // A focused widget (or furniture) is one stop: one press leaves it for the
    // next stop in that direction, past any furniture between.
    const indices = selection
      .getNodes()
      .map((node) => children.findIndex((child) => child.is(node)))
      .filter((index) => index !== -1);
    if (indices.length === 0) return false;
    if (!indices.every((index) => caretKind(types[index]) !== 'text')) {
      return false;
    }
    const from =
      direction === 'next' ? Math.max(...indices) : Math.min(...indices);
    event.preventDefault();
    const stop = nextStop(types, from, direction);
    if (stop !== undefined) $landOn(children[stop], direction);
    return true;
  }

  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

  // Where the movement continues from: the seam between two blocks, or the
  // caret's own block at its edge toward the movement.
  const anchor = selection.anchor;
  let from: number;
  let block: LexicalNode | null = null;
  let seam = false;
  if (anchor.type === 'element' && $isRootNode(anchor.getNode())) {
    from = direction === 'next' ? anchor.offset - 1 : anchor.offset;
    seam = true;
  } else {
    block = $blockOf(anchor.getNode());
    if (block === null) return false;
    const index = children.findIndex((child) => child.is(block));
    if (index === -1) return false;
    if (direction === 'next') {
      if (!$atBlockEnd(selection, block)) return false;
    } else if (!$atBlockStart(selection, block)) {
      return false;
    }
    from = index;
  }

  // Only a step onto furniture is this plugin's; every other movement is the
  // editor's, which already knows text and widgets.
  const first = from + step;
  if (first < 0 || first >= types.length) return false;
  if (caretKind(types[first]) !== 'furniture') return false;
  if (
    byLine &&
    !seam &&
    block !== null &&
    !$lineLeavesBlock(editor, block, direction)
  ) {
    return false;
  }

  event.preventDefault();
  const stop = nextStop(types, from, direction);
  if (stop !== undefined) $landOn(children[stop], direction);
  return true;
};

/** Open or close the one widget the node selection holds, if it holds one. */
const $toggleFocused = (): void => {
  const selection = $getSelection();
  if (!$isNodeSelection(selection)) return;
  const nodes = selection.getNodes();
  if (nodes.length !== 1) return;
  const node = nodes[0];
  if (
    $isThinkingTurnNode(node) ||
    $isToolTurnNode(node) ||
    $isActivityTurnNode(node)
  ) {
    node.toggle();
  }
};

/** What Enter does where the caret is: toggle a widget, or nothing on furniture. */
const $handleEnter = (event: KeyboardEvent | null): boolean => {
  const selection = $getSelection();
  const selectedTypes = $isNodeSelection(selection)
    ? selection.getNodes().map((node) => node.getType())
    : [];
  const chorded = event !== null && (event.metaKey || event.ctrlKey);
  const action = enterAction(selectedTypes, chorded);
  if (action === 'default') return false;
  event?.preventDefault();
  if (action === 'toggle') $toggleFocused();
  return true;
};

/**
 * A click on an author line is a click on furniture and takes no caret: the
 * caret goes to the stop before the line — the block it names — or to the one
 * after it when none sits before.
 */
const $handleFurnitureClick = (event: MouseEvent): boolean => {
  const target = getComposedEventTarget(event);
  if (!isDOMNode(target)) return false;
  const author = $getNearestNodeFromDOMNode(target);
  if (!$isTurnAuthorNode(author)) return false;
  event.preventDefault();
  const children = $getRoot().getChildren();
  const types = $blockTypes();
  const index = children.findIndex((child) => child.is(author));
  if (index === -1) return true;
  const previous = nextStop(types, index, 'previous');
  const stop = previous ?? nextStop(types, index, 'next');
  if (stop !== undefined) {
    $landOn(children[stop], previous === undefined ? 'next' : 'previous');
  }
  return true;
};

/** The conversation's caret keys and clicks, answered above the editor's own. */
export function CaretNavigation() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          KEY_ARROW_LEFT_COMMAND,
          (event) => $handleArrow(editor, 'previous', false, event),
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_ARROW_RIGHT_COMMAND,
          (event) => $handleArrow(editor, 'next', false, event),
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_ARROW_UP_COMMAND,
          (event) => $handleArrow(editor, 'previous', true, event),
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_ARROW_DOWN_COMMAND,
          (event) => $handleArrow(editor, 'next', true, event),
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_ENTER_COMMAND,
          $handleEnter,
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          CLICK_COMMAND,
          $handleFurnitureClick,
          COMMAND_PRIORITY_LOW,
        ),
      ),
    [editor],
  );

  return null;
}
