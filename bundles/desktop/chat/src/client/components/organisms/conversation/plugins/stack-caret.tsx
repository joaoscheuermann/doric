// The caret between the prompt's words and the comment stack drawn above them,
// inside the prompt's block. The stack's notes are editing hosts of their own
// inside the conversation's document, so the editor cannot walk into them:
// ArrowUp on the prompt's first line puts the caret at the end of the last
// note here — or, while the stack is folded, on its header — and a note hands
// the caret back to the prompt through `focusPrompt`.

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $hasAncestor,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  getDOMSelection,
  KEY_ARROW_UP_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
} from 'lexical';
import { useEffect } from 'react';

import { placeCaret } from '../../../../utility/note-caret.js';
import { STACK_NOTE_ATTRIBUTE } from '../../../molecules/stack-note.js';
import {
  $getUserPromptNode,
  type UserPromptNode,
} from '../nodes/user-prompt-node.js';

/** The notes of the stack's own list, never a comment written inline. */
export const STACK_NOTES_SELECTOR = `[data-composer-stack-list] [${STACK_NOTE_ATTRIBUTE}]`;

/** The header that folds the stack's comments. */
export const STACK_HEADER_SELECTOR = '[data-comment-group-header]';

/** The stack's notes the editor shows, in stack order. */
const stackNotes = (editor: LexicalEditor): HTMLElement[] => [
  ...(editor
    .getRootElement()
    ?.querySelectorAll<HTMLElement>(STACK_NOTES_SELECTOR) ?? []),
];

/** The stack's header, while the stack holds a comment. */
const stackHeader = (editor: LexicalEditor): HTMLElement | null =>
  editor
    .getRootElement()
    ?.querySelector<HTMLElement>(
      `[data-composer-stack] ${STACK_HEADER_SELECTOR}`,
    ) ?? null;

/** Puts the caret in the prompt, at its start or its end. */
export const focusPrompt = (editor: LexicalEditor, atEnd: boolean): void => {
  // The editor applies its selection to the DOM only while its own root holds
  // the focus, so the focus moves first.
  editor.getRootElement()?.focus({ preventScroll: true });
  editor.update(() => {
    const prompt = $getUserPromptNode();
    if (prompt === undefined) return;
    if (atEnd) prompt.selectEnd();
    else prompt.selectStart();
  });
};

/** The text of the prompt before the caret, line breaks included. */
const $textBefore = (
  prompt: UserPromptNode,
  selection: RangeSelection,
): string => {
  const anchor = selection.anchor;
  let node: LexicalNode | null = anchor.getNode();
  let text = $isElementNode(node)
    ? node
        .getChildren()
        .slice(0, anchor.offset)
        .map((child) => child.getTextContent())
        .join('')
    : node.getTextContent().slice(0, anchor.offset);
  while (node !== null && !node.is(prompt)) {
    for (
      let sibling = node.getPreviousSibling();
      sibling !== null;
      sibling = sibling.getPreviousSibling()
    ) {
      text = sibling.getTextContent() + text;
    }
    node = node.getParent();
  }
  return text;
};

/**
 * Whether the caret is on the prompt's first line: no line break before it,
 * and — where the browser draws the caret — no wrapped line above it.
 */
const $onFirstLine = (
  editor: LexicalEditor,
  prompt: UserPromptNode,
  selection: RangeSelection,
): boolean => {
  if ($textBefore(prompt, selection).includes('\n')) return false;
  const element = editor.getElementByKey(prompt.getKey());
  const view = element?.ownerDocument.defaultView ?? null;
  const dom = getDOMSelection(view);
  if (element === null || dom === null || dom.rangeCount === 0) return true;
  const range = dom.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getClientRects?.()[0];
  if (rect === undefined || (rect.width === 0 && rect.height === 0))
    return true;
  const line =
    Number.parseFloat(view?.getComputedStyle(element).lineHeight ?? '') || 20;
  return rect.top - element.getBoundingClientRect().top < line * 0.8;
};

/**
 * ArrowUp from the prompt's first line into the stack's last note, or onto
 * its header while the stack is folded.
 */
export function StackCaret() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event) => {
          if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey)
            return false;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed())
            return false;
          const prompt = $getUserPromptNode();
          if (prompt === undefined) return false;
          const anchor = selection.anchor.getNode();
          if (!anchor.is(prompt) && !$hasAncestor(anchor, prompt)) return false;
          const last = stackNotes(editor).at(-1);
          const header = last === undefined ? stackHeader(editor) : null;
          if (last === undefined && header === null) return false;
          if (!$onFirstLine(editor, prompt, selection)) return false;
          event.preventDefault();
          if (last !== undefined) placeCaret(last, true);
          else header?.focus({ preventScroll: true });
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    [editor],
  );

  return null;
}
