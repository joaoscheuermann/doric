import { cn } from '@/utility/utils';
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
  readonly children: ReactNode;
};

/**
 * A widget of the conversation focused as a unit.
 *
 * The caret never enters a widget — a thinking run, a tool call, an activity
 * summary is one stop — and its focus is the editor's node selection, drawn here
 * as a quiet frame. A click takes that focus as a unit (with Shift it adds the
 * widget to the selection instead), while the controls inside keep their own
 * behaviour: the chevron still opens and closes. The frame is editor-internal
 * focus and moves neither DOM focus nor scroll.
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

  return (
    <div
      className={cn(
        'rounded-md transition-colors',
        isSelected && 'bg-muted/50 ring-1 ring-border',
      )}
      ref={frame}
    >
      {children}
    </div>
  );
}
