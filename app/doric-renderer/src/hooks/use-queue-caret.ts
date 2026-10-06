import { $isQueueNode } from '@/components/organisms/conversation/nodes/queue-node';
import { $getUserPromptNode } from '@/components/organisms/conversation/nodes/user-prompt-node';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import {
  $addUpdateTag,
  $createNodeSelection,
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $setSelection,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  mergeRegister,
  type NodeKey,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import { type KeyboardEvent, useEffect } from 'react';

/** Queue rows are read-only caret stops; only an explicit delete removes an input. */
export function useQueueCaret(
  nodeKey: NodeKey,
  ids: readonly string[],
  remove: (id: string) => void,
  edit: (id: string) => boolean,
) {
  const [editor] = useLexicalComposerContext();
  const [selected] = useLexicalNodeSelection(nodeKey);
  useEffect(() => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isQueueNode(node)) return;
      node.setItems(ids);
      const selection = $getSelection();
      if (
        $isNodeSelection(selection) &&
        selection.has(nodeKey) &&
        ids.length === 0
      )
        $getUserPromptNode()?.selectEnd();
      else $addUpdateTag(SKIP_DOM_SELECTION_TAG);
    });
  }, [editor, ids, nodeKey]);
  useEffect(() => {
    const focused = () => {
      const selection = $getSelection();
      const node = $getNodeByKey(nodeKey);
      return $isNodeSelection(selection) &&
        selection.getNodes().length === 1 &&
        selection.has(nodeKey) &&
        $isQueueNode(node)
        ? node.focused()
        : undefined;
    };
    const deletion = (event: globalThis.KeyboardEvent) => {
      const id = focused();
      if (id === undefined) return false;
      event.preventDefault();
      if (!event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey)
        remove(id);
      return true;
    };
    return mergeRegister(
      editor.registerCommand(
        KEY_DELETE_COMMAND,
        deletion,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        deletion,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event?.metaKey || event?.ctrlKey) return false;
          const id = focused();
          if (id === undefined) return false;
          event?.preventDefault();
          if (edit(id)) return true;
          editor
            .getElementByKey(nodeKey)
            ?.querySelector<HTMLButtonElement>(`[data-queue-id="${id}"]`)
            ?.click();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    );
  }, [edit, editor, nodeKey, remove]);
  const focus = (id: string) =>
    editor.update(
      () => {
        const node = $getNodeByKey(nodeKey);
        if (!$isQueueNode(node)) return;
        node.focusItem(id);
        const selection = $createNodeSelection();
        selection.add(nodeKey);
        $setSelection(selection);
      },
      { tag: SKIP_DOM_SELECTION_TAG },
    );
  const keyDown = (id: string, event: KeyboardEvent) => {
    event.stopPropagation();
    const command = {
      ArrowUp: KEY_ARROW_UP_COMMAND,
      ArrowDown: KEY_ARROW_DOWN_COMMAND,
      ArrowLeft: KEY_ARROW_LEFT_COMMAND,
      ArrowRight: KEY_ARROW_RIGHT_COMMAND,
      Delete: KEY_DELETE_COMMAND,
      Backspace: KEY_BACKSPACE_COMMAND,
      Enter: KEY_ENTER_COMMAND,
    }[event.key];
    if (command === undefined) return;
    event.preventDefault();
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isQueueNode(node)) return;
      node.focusItem(id);
      const selection = $createNodeSelection();
      selection.add(nodeKey);
      $setSelection(selection);
      editor.dispatchCommand(command, event.nativeEvent);
    });
    editor.getRootElement()?.focus({ preventScroll: true });
  };
  return { selected, focus, keyDown };
}
