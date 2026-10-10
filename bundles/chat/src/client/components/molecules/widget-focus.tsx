import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import {
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  getComposedEventTarget,
  isDOMNode,
  type NodeKey,
} from 'lexical';
import { type ReactNode, useEffect, useRef } from 'react';

type WidgetFocusProps = {
  /** The node the widget is built on: what the focus selects. */
  readonly nodeKey: NodeKey;
  /** The widget's parts, told whether the widget holds the caret. */
  readonly children: (focused: boolean) => ReactNode;
};

/**
 * A widget of the conversation focused as a unit.
 *
 * The caret never enters a widget — a thinking run, a tool call, an activity
 * summary is one stop — and its focus is the editor's node selection. The parts
 * draw that focus themselves, in their own hover style, so a focused widget
 * looks the way it does under the pointer and wears no frame of its own. A
 * click takes that focus as a unit (with Shift it adds the widget to the
 * selection instead), while the controls inside keep their own behaviour: the
 * chevron still opens and closes. The focus is editor-internal and moves
 * neither DOM focus nor scroll.
 */
export function WidgetFocus({ children, nodeKey }: WidgetFocusProps) {
  const [editor] = useLexicalComposerContext();
  const [isSelected, setSelected, clearSelected] =
    useLexicalNodeSelection(nodeKey);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      editor.registerCommand(
        CLICK_COMMAND,
        (event) => {
          const element = frame.current;
          const target = getComposedEventTarget(event);
          if (
            element === null ||
            !isDOMNode(target) ||
            !element.contains(target)
          ) {
            return false;
          }
          event.preventDefault();
          if (!event.shiftKey) clearSelected();
          setSelected(true);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [clearSelected, editor, setSelected],
  );

  return <div ref={frame}>{children(isSelected)}</div>;
}
