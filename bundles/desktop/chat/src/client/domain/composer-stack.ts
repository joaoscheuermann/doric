// The comment stack's own vocabulary, stated in terms of its arguments: the
// fields of an item's data the chat reads, the anchor label a line shows at its
// end and the summary a line reads out. The words the stack adds to a send are
// the prompt envelope's (`prompt-envelope.ts`). The chat never interprets a
// target — it reads only the anchor's own fields, which the `comments`
// bundle's four anchor forms name (`docs/architecture/bundles/comments.md`,
// "A âncora").

import type { ComposerItem } from '../../contracts/index.js';

/** The anchor's own fields, as the four forms of `comments/v1` declare them. */
interface AnchorShape {
  readonly form?: unknown;
  readonly path?: unknown;
  readonly line?: unknown;
  readonly selector?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly label?: unknown;
  readonly text?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/** The anchor of a comment target, else `undefined`. */
export const anchorOf = (target: unknown): AnchorShape | undefined =>
  asRecord(asRecord(target)?.anchor);

/** The last segment of a workspace path: the file's own name. */
const basename = (path: string): string =>
  path
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .at(-1) ?? path;

/**
 * The label a line ends with: the stamped file (its name and line, after the
 * element's label when the anchor names one: `button · Checkout.tsx:42`), the
 * selector, the free position (with the nearest element's label), or the
 * selected text — the four forms of `comments/v1`, in that order of strength.
 */
export const anchorLabel = (target: unknown): string | undefined => {
  const anchor = anchorOf(target);
  if (anchor === undefined) return undefined;

  if (typeof anchor.path === 'string' && anchor.path.length > 0) {
    const file =
      typeof anchor.line === 'number'
        ? `${basename(anchor.path)}:${anchor.line}`
        : basename(anchor.path);
    return typeof anchor.label === 'string' && anchor.label.length > 0
      ? `${anchor.label} · ${file}`
      : file;
  }

  if (typeof anchor.selector === 'string' && anchor.selector.length > 0) {
    return anchor.selector;
  }

  if (typeof anchor.x === 'number' && typeof anchor.y === 'number') {
    const position = `${anchor.x}, ${anchor.y}`;
    const near =
      typeof anchor.label === 'string' && anchor.label.length > 0
        ? anchor.label
        : undefined;

    return near === undefined ? position : `${near} (${position})`;
  }

  if (typeof anchor.text === 'string' && anchor.text.trim().length > 0) {
    return `“${anchor.text.trim()}”`;
  }

  return undefined;
};

/** The comment target a stack item's owner gave it, else `undefined`. */
export const itemTarget = (item: ComposerItem): unknown =>
  asRecord(item.data)?.target;

/**
 * Where in the conversation a comment about it sits: the turn's own key and
 * the 0-based index of the block the selection started in.
 */
export interface SeatRef {
  readonly turn: string;
  readonly block: number;
}

/**
 * The fields of a stack item's data the chat reads (`ComposerItemData`), each
 * kept only when it has the declared type; anything else the owner stored is
 * left alone. The target stays unknown: its anchor is read through
 * `anchorOf`, and its identity through `targetKey`.
 */
export interface ItemData {
  readonly target?: unknown;
  readonly pin?: number;
  readonly inReplyTo?: string;
  readonly refs?: { readonly title?: string; readonly source?: string };
  /** The turn and block the item's comment was written at, when it names one. */
  readonly seat?: SeatRef;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** A seat, when it names a turn and a 0-based block; never a half one. */
const seatOfRecord = (value: unknown): SeatRef | undefined => {
  const seat = asRecord(value);
  const turn = text(seat?.turn);
  const block = seat?.block;

  return turn === undefined ||
    typeof block !== 'number' ||
    !Number.isInteger(block) ||
    block < 0
    ? undefined
    : { turn, block };
};

/** Reads a stack item's data by the stack's convention. */
export const itemData = (item: ComposerItem): ItemData => {
  const data = asRecord(item.data);
  if (data === undefined) return {};
  const pin = data.pin;
  const inReplyTo = text(data.inReplyTo);
  const refs = asRecord(data.refs);
  const title = text(refs?.title);
  const source = text(refs?.source);
  const seat = seatOfRecord(data.seat);

  return {
    ...(data.target === undefined ? {} : { target: data.target }),
    ...(typeof pin === 'number' && Number.isFinite(pin) ? { pin } : {}),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    ...(title === undefined && source === undefined
      ? {}
      : {
          refs: {
            ...(title === undefined ? {} : { title }),
            ...(source === undefined ? {} : { source }),
          },
        }),
    ...(seat === undefined ? {} : { seat }),
  };
};

/** The seat a stack item carries, else `undefined`: the turn and its block. */
export const seatOf = (item: ComposerItem): SeatRef | undefined =>
  itemData(item).seat;

/** The identity of a comment target — kind, id and revision — else `undefined`. */
export const targetKey = (
  target: unknown,
):
  | { readonly kind: string; readonly id: string; readonly revision?: number }
  | undefined => {
  const record = asRecord(target);
  const kind = text(record?.kind);
  const id = text(record?.id);
  if (kind === undefined || id === undefined) return undefined;
  const revision = record?.revision;

  return typeof revision === 'number' && Number.isFinite(revision)
    ? { kind, id, revision }
    : { kind, id };
};

/** The anchor label of a stack item's target, else `undefined`. */
export const itemAnchorLabel = (item: ComposerItem): string | undefined =>
  anchorLabel(itemTarget(item));

/** The line a stack item reads out: its author and its note. */
export const itemSummary = (item: ComposerItem): string =>
  `${item.author ?? 'reader'}: ${item.note}`;

/** Whether a send with these items carries any words of its own. */
export const stackHasWords = (items: readonly ComposerItem[]): boolean =>
  items.some((item) => item.note.trim().length > 0);

/** Where the caret goes from a stack note: another note, or the prompt. */
export type NoteCaret =
  | { readonly to: 'note'; readonly index: number; readonly atEnd: boolean }
  | { readonly to: 'prompt'; readonly atEnd: boolean };

/** What one key pressed in a stack note does. */
export type NoteKeyAction =
  /** The browser's own editing of the note. */
  | { readonly kind: 'default' }
  /** Sends the prompt with the stack, through the composer's send. */
  | { readonly kind: 'send' }
  /** Removes the note's comment from the stack. */
  | { readonly kind: 'remove' }
  /** Moves the caret out of the note. */
  | ({ readonly kind: 'move' } & NoteCaret);

/** The key, as a stack note reads it. */
export interface NoteKey {
  readonly key: string;
  /** Cmd on macOS, Ctrl elsewhere — either is the chord. */
  readonly mod: boolean;
  readonly shift: boolean;
}

/** Where the caret stands when the key is pressed. */
export interface NoteCaretState {
  /** The note's position in the stack, and how many notes the stack holds. */
  readonly index: number;
  readonly count: number;
  /** Whether the note holds no text. */
  readonly empty: boolean;
  /** Whether the caret is on the note's first or last visual line. */
  readonly firstLine: boolean;
  readonly lastLine: boolean;
}

/**
 * What a key does in a stack note. The notes and the prompt read as the lines
 * of one document: the arrows walk the caret between them by visual line, and
 * down from the last note enters the prompt at its start; Enter moves on to
 * the next note or the prompt's end, and Escape returns to the prompt's end.
 * Cmd/Ctrl+Enter sends; Cmd/Ctrl+Backspace — or Backspace and Delete in an
 * empty note — removes the comment. Every other key edits the note.
 */
export const noteKeyAction = (
  key: NoteKey,
  at: NoteCaretState,
): NoteKeyAction => {
  const next = at.index + 1 < at.count;
  if (key.key === 'Enter' && key.mod) return { kind: 'send' };
  if (key.key === 'Backspace' && key.mod) return { kind: 'remove' };
  if ((key.key === 'Backspace' || key.key === 'Delete') && at.empty)
    return { kind: 'remove' };
  if (key.key === 'Enter')
    return next
      ? { kind: 'move', to: 'note', index: at.index + 1, atEnd: true }
      : { kind: 'move', to: 'prompt', atEnd: true };
  if (key.key === 'Escape') return { kind: 'move', to: 'prompt', atEnd: true };
  if (key.shift || key.mod) return { kind: 'default' };
  if (key.key === 'ArrowUp' && at.firstLine && at.index > 0)
    return { kind: 'move', to: 'note', index: at.index - 1, atEnd: true };
  if (key.key === 'ArrowDown' && at.lastLine)
    return next
      ? { kind: 'move', to: 'note', index: at.index + 1, atEnd: false }
      : { kind: 'move', to: 'prompt', atEnd: false };
  return { kind: 'default' };
};

/**
 * Where the caret goes once the note at `index` is removed from a stack of
 * `count`: the end of the note before it, else the start of the one after it,
 * else the prompt. The index names the note in the stack as it stood before
 * the removal.
 */
export const caretAfterRemoval = (index: number, count: number): NoteCaret => {
  if (index > 0) return { to: 'note', index: index - 1, atEnd: true };
  if (index + 1 < count) return { to: 'note', index: index + 1, atEnd: false };
  return { to: 'prompt', atEnd: false };
};
