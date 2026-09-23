import type { PromptTurn } from './projector';

/**
 * A prose node is the unit a human reads, edits, or comments on. User prompts
 * and agent answers are nodes; thinking, tool and delegated rows are machine
 * content and are not. The draft is the document's last node.
 */
export type ProseNode = {
  readonly id: string;
  readonly role: 'user' | 'agent' | 'draft';
  /** The prompt this node belongs to; absent for the draft. */
  readonly promptId?: string;
  /** The text the projection produced, which an edit is compared against. */
  readonly original: string;
};

export const draftNodeId = 'draft';

/** The node that holds a past turn's prompt text. */
export const userNodeId = (promptId: string): string => `${promptId}:prompt`;

/** The node that holds one answer segment of a turn. */
export const textNodeId = (promptId: string, index: number): string =>
  `${promptId}:text:${index}`;

export const userNode = (promptId: string, text: string): ProseNode => ({
  id: userNodeId(promptId),
  role: 'user',
  promptId,
  original: text,
});

export const agentNode = (
  promptId: string,
  index: number,
  text: string,
): ProseNode => ({
  id: textNodeId(promptId, index),
  role: 'agent',
  promptId,
  original: text,
});

/** The draft is the document's last prose node: the composer itself. */
export const draftNode: ProseNode = {
  id: draftNodeId,
  role: 'draft',
  original: '',
};

/**
 * The conversation's prose nodes in document order. A prompt whose recorded
 * text is absent, and an empty answer segment, have nothing to read or edit and
 * are left out.
 */
export const proseNodes = (
  turns: readonly PromptTurn[],
): readonly ProseNode[] =>
  turns.flatMap((turn) => [
    ...(turn.accepted &&
    turn.delegated === undefined &&
    turn.userMarkdown.length > 0
      ? [userNode(turn.promptId, turn.userMarkdown)]
      : []),
    ...turn.segments.flatMap((segment, index) =>
      segment.kind === 'text' && segment.text.length > 0
        ? [agentNode(turn.promptId, index, segment.text)]
        : [],
    ),
  ]);

/**
 * Whether an edit has moved a node away from the text the projection produced.
 * Only a user node can be dirty: an agent answer never mutates, and the draft
 * is new text with nothing to diverge from.
 */
export const isDirty = (
  node: ProseNode,
  edits: Readonly<Record<string, string>>,
): boolean => {
  if (node.role !== 'user') return false;
  const edited = edits[node.id];
  return edited !== undefined && edited !== node.original;
};

/**
 * The index of the first dirty node, or -1 when the document matches the
 * projection. Every node below that index renders dimmed, and the dimming
 * clears as soon as the edit returns to the original text.
 */
export const dirtyIndex = (
  nodes: readonly ProseNode[],
  edits: Readonly<Record<string, string>>,
): number => nodes.findIndex((node) => isDirty(node, edits));

/** The excerpt a comment was started over. */
export type CommentAnchor = {
  readonly quote: string;
  readonly start: number;
  readonly end: number;
};

export type Comment = {
  readonly id: string;
  /** The agent node the comment is attached to. */
  readonly nodeId: string;
  /** What the human typed. */
  readonly text: string;
  /** The rendered Markdown block the comment sits under. */
  readonly block: number;
  /** Set when the comment was started over a selection, not a bare caret. */
  readonly anchor?: CommentAnchor;
};

/**
 * Splits Markdown into blank-line separated blocks, keeping a fenced code block
 * whole so a blank line inside it does not cut the fence. A comment renders under
 * the block its anchor sits in, which is why the split has to match the render.
 */
export const markdownBlocks = (source: string): readonly string[] => {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  for (const line of source.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined && marker !== undefined) {
      fence = marker;
    } else if (
      fence !== undefined &&
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length
    ) {
      fence = undefined;
    }
    if (fence === undefined && line.trim().length === 0) {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
};

/** Whether two anchors cover the same excerpt, with a bare caret counting as one. */
export const sameAnchor = (
  left: CommentAnchor | undefined,
  right: CommentAnchor | undefined,
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.start === right.start && left.end === right.end;

/**
 * Whether typing belongs to the active comment or starts a new one. A different
 * excerpt is a different comment, so each selected range keeps its own text; a
 * caret continues the comment it is still inside, because a selection collapses
 * as soon as the first character is consumed.
 */
export const continuesComment = (
  comment: Comment | undefined,
  anchor: CommentAnchor | undefined,
  block: number,
): boolean => {
  if (comment === undefined) return false;
  return anchor === undefined
    ? comment.block === block
    : sameAnchor(comment.anchor, anchor);
};

export const commentsFor = (
  comments: readonly Comment[],
  nodeId: string,
): readonly Comment[] =>
  comments.filter((comment) => comment.nodeId === nodeId);

export const startComment = (
  comments: readonly Comment[],
  comment: Comment,
): readonly Comment[] => [...comments, comment];

export const extendComment = (
  comments: readonly Comment[],
  id: string,
  text: string,
): readonly Comment[] =>
  comments.map((comment) =>
    comment.id === id ? { ...comment, text: comment.text + text } : comment,
  );

/** Removes one character; a comment that loses its last character is dropped. */
export const trimComment = (
  comments: readonly Comment[],
  id: string,
): readonly Comment[] =>
  comments.flatMap((comment) => {
    if (comment.id !== id) return [comment];
    const text = Array.from(comment.text).slice(0, -1).join('');
    return text.length === 0 ? [] : [{ ...comment, text }];
  });

export const removeComment = (
  comments: readonly Comment[],
  id: string,
): readonly Comment[] => comments.filter((comment) => comment.id !== id);

/**
 * Appends the pending comments to a prompt as a Markdown section. A comment
 * started over a selection quotes its excerpt in double quotes; a caret comment
 * is a plain bullet. With no comments the prompt is returned unchanged, so a
 * plain prompt carries no empty section.
 */
export const composePrompt = (
  text: string,
  comments: readonly Comment[],
): string => {
  if (comments.length === 0) return text;
  const section = [
    '## Comments',
    '',
    ...comments.map((comment) =>
      comment.anchor === undefined
        ? `- ${comment.text}`
        : `- "${comment.anchor.quote}": ${comment.text}`,
    ),
  ].join('\n');
  return text.length === 0 ? section : `${text}\n\n${section}`;
};

export type CaretEdge = 'start' | 'end';

export type CaretTarget = {
  readonly id: string;
  readonly edge: CaretEdge;
};

/**
 * The node an arrow key moves the caret to once it has reached the current
 * node's edge, or `undefined` at the document's boundary. Moving left lands at
 * the previous node's end; moving right lands at the next node's start.
 */
/** The keys that hand the caret to a neighbouring node at an edge. */
export type CaretKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export const caretTarget = (
  nodes: readonly ProseNode[],
  id: string,
  key: CaretKey,
): CaretTarget | undefined => {
  const index = nodes.findIndex((node) => node.id === id);
  if (index === -1) return undefined;
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    const previous = nodes[index - 1];
    return previous === undefined
      ? undefined
      : { id: previous.id, edge: 'end' };
  }
  const next = nodes[index + 1];
  return next === undefined ? undefined : { id: next.id, edge: 'start' };
};
