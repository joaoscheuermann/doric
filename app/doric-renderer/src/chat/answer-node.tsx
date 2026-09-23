import { useEffect, useState } from 'react';

import { Document } from './document';
import type {
  CaretEdge,
  CaretKey,
  Comment,
  CommentAnchor,
  ProseNode,
} from './editing';
import type { PromptStatus } from './projector';
import { initialVisibleMarkdown, revealStep } from './reveal';
import { TurnNode } from './turn-node';

const terminal = (status: PromptStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

export type AnswerHandlers = {
  readonly blur: () => void;
  readonly focus: (edge?: CaretEdge) => void;
  readonly backspace: () => void;
  readonly navigate: (key: CaretKey) => boolean;
  readonly removeComment: (id: string) => void;
  readonly type: (
    text: string,
    anchor: CommentAnchor | undefined,
    block: number,
  ) => void;
};

/**
 * One answer segment. It renders through the same surface in every state — the
 * typewriter only decides how much text that surface is given — so focusing the
 * node never changes how the answer looks, and a pending comment stays where it
 * was put.
 */
export function AnswerNode({
  node,
  text,
  status,
  live,
  comments,
  dimmed,
  focused,
  focusEdge,
  handlers,
}: {
  readonly node: ProseNode;
  readonly text: string;
  readonly status: PromptStatus;
  readonly live: boolean;
  readonly comments: readonly Comment[];
  readonly dimmed: boolean;
  readonly focused: boolean;
  /** Where to place the caret when this node is opened by an arrow key. */
  readonly focusEdge?: CaretEdge;
  readonly handlers: AnswerHandlers;
}) {
  const [visible, setVisible] = useState(() =>
    initialVisibleMarkdown(text, live),
  );

  useEffect(() => {
    if (!live) {
      setVisible(text);
      return;
    }
    if (visible === text) return;
    const frame = requestAnimationFrame(() =>
      setVisible((current) =>
        revealStep({
          receivedMarkdown: text,
          visibleMarkdown: current,
          terminal: terminal(status),
        }),
      ),
    );
    return () => cancelAnimationFrame(frame);
  }, [live, text, status, visible]);

  return (
    <TurnNode
      dimmed={dimmed}
      focused={focused}
      node={node}
      onBlur={handlers.blur}
      onFocus={handlers.focus}
    >
      <Document
        className="font-serif text-sm leading-7 outline-none"
        comments={comments}
        editable
        focusEdge={focusEdge}
        handlers={{
          onBackspace: handlers.backspace,
          onNavigate: handlers.navigate,
          onRemoveComment: handlers.removeComment,
          onType: handlers.type,
        }}
        mode="read"
        text={visible}
      />
    </TurnNode>
  );
}
