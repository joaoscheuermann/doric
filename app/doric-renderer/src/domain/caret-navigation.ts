/**
 * How the caret navigates the conversation's blocks.
 *
 * The caret treats a block of the transcript in one of three ways, decided by
 * the type name the block reports: ordinary text the caret crosses like any
 * rich text, a widget it focuses as a whole in one stop, and furniture it never
 * enters — the author line, which carries the agent's or the reader's name and
 * is not content. Movement never lands on furniture: a step that would land
 * there continues to the next stop instead, and a step with no stop left stays
 * where the caret is.
 */
import {
  ACTIVITY_TURN_BLOCK,
  DELEGATED_TURN_BLOCK,
  FAILURE_TURN_BLOCK,
  LIFECYCLE_TURN_BLOCK,
  THINKING_TURN_BLOCK,
  TOOL_TURN_BLOCK,
  TURN_AUTHOR_BLOCK,
} from './conversation-nodes';

/** How the caret treats a block of the conversation. */
export type CaretKind =
  /** Text: the caret crosses it like any rich text. */
  | 'text'
  /** A widget: one caret stop, focused as a whole. */
  | 'widget'
  /** Furniture — the author line — which the caret never enters. */
  | 'furniture';

/** How the caret treats a block that reports this type. */
export const caretKind = (nodeType: string): CaretKind => {
  if (nodeType === TURN_AUTHOR_BLOCK || nodeType === LIFECYCLE_TURN_BLOCK)
    return 'furniture';
  if (
    nodeType === THINKING_TURN_BLOCK ||
    nodeType === DELEGATED_TURN_BLOCK ||
    nodeType === TOOL_TURN_BLOCK ||
    nodeType === ACTIVITY_TURN_BLOCK ||
    nodeType === FAILURE_TURN_BLOCK
  ) {
    return 'widget';
  }
  return 'text';
};

/** The way a step of movement goes. */
export type Direction = 'previous' | 'next';

/**
 * The block the caret lands on when it moves one step in `direction` from block
 * `from`: the first block strictly beyond it that is not furniture. Author
 * lines are stepped over, a widget or text block stops the walk, and a walk
 * that runs out of blocks finds none.
 */
export const nextStop = (
  types: readonly string[],
  from: number,
  direction: Direction,
): number | undefined => {
  const step = direction === 'next' ? 1 : -1;
  for (
    let index = from + step;
    index >= 0 && index < types.length;
    index += step
  ) {
    if (caretKind(types[index]) !== 'furniture') return index;
  }
  return undefined;
};

/** Where the caret stands inside a focused activity summary. */
export type ItemCursor =
  /** The summary's own header line. */
  | null
  /** One of the summary's steps, by index. */
  | number;

/** Where the caret goes inside a focused activity summary. */
export type ItemTarget =
  /** The summary's header line, or one of its steps, by index. */
  | ItemCursor
  /** Outside the summary, where the block walk continues beside it. */
  | 'leave';

/**
 * The stop the caret enters an activity summary on from `direction`: the header
 * line when it walks in from above, the last step when it walks in from below,
 * and the header alone when the summary shows no steps. `items` counts the steps
 * the summary shows — a closed summary shows none — so the summary and its steps
 * read as one run of stops whichever side the caret comes from.
 */
export const entryItem = (items: number, direction: Direction): ItemCursor =>
  direction === 'previous' && items > 0 ? items - 1 : null;

/**
 * The stop the caret takes next inside a focused activity summary: the next
 * step in `direction`, the header line at the summary's own edge, and `leave`
 * past the last step — which hands the movement back to the block walk beside
 * the summary.
 */
export const nextItem = (
  cursor: ItemCursor,
  items: number,
  direction: Direction,
): ItemTarget => {
  if (cursor === null) {
    return direction === 'next' && items > 0 ? 0 : 'leave';
  }
  const target = cursor + (direction === 'next' ? 1 : -1);
  if (target < 0) return null;
  return target < items ? target : 'leave';
};

/** What Enter does where the caret is. */
export type EnterAction =
  /** The focused widget opens or closes. */
  | 'toggle'
  /** Furniture holds nothing to open and nothing to type; Enter does nothing. */
  | 'nothing'
  /** The editor's own Enter: a line in the prompt, a send on Cmd/Ctrl+Enter. */
  | 'default';

/**
 * What Enter does where the caret is: `selectedTypes` are the types the node
 * selection covers — none when the caret sits in text — and `chorded` is
 * Cmd/Ctrl held, the send chord, which sends wherever the caret is. A single
 * focused widget toggles; a selection of conversation widgets or furniture has
 * nothing to type into, so Enter does nothing; everything else is the editor's
 * own Enter, unchanged.
 */
export const enterAction = (
  selectedTypes: readonly string[],
  chorded: boolean,
): EnterAction => {
  if (chorded) return 'default';
  const kinds = selectedTypes.map(caretKind);
  if (kinds.length === 1 && kinds[0] === 'widget') return 'toggle';
  if (kinds.length > 0 && kinds.every((kind) => kind !== 'text')) {
    return 'nothing';
  }
  return 'default';
};
