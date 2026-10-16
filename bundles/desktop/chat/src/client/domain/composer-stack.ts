// The comment stack's own vocabulary, stated in terms of its arguments: the
// anchor label a line shows at its end, the summary a line reads out, and the
// words a comment-only send carries. The chat never interprets a target — it
// reads only the anchor's own fields, which the `comments` bundle's four anchor
// forms name (`docs/architecture/bundles/comments.md`, "A âncora").

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

/**
 * The label a line ends with: the stamped `path:line`, the selector, the free
 * position (with the nearest element's label), or the selected text — the
 * four forms of `comments/v1`, in that order of strength.
 */
export const anchorLabel = (target: unknown): string | undefined => {
  const anchor = anchorOf(target);
  if (anchor === undefined) return undefined;

  if (
    typeof anchor.path === 'string' &&
    anchor.path.length > 0 &&
    typeof anchor.line === 'number'
  ) {
    return `${anchor.path}:${anchor.line}`;
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

/** The anchor label of a stack item's target, else `undefined`. */
export const itemAnchorLabel = (item: ComposerItem): string | undefined =>
  anchorLabel(itemTarget(item));

/** The line a stack item reads out: its author and its note. */
export const itemSummary = (item: ComposerItem): string =>
  `${item.author ?? 'reader'}: ${item.note}`;

/**
 * The words a send carries when the editor holds none: one Markdown line per
 * item, its note and the anchor it is pinned to. The host accepts only a
 * non-empty prompt, and a comment alone is already something to send — this is
 * the prompt that carries it, in the anchor's own words, as the log will read
 * it. Items without a note have nothing to ask yet and are left out.
 */
export const stackPromptText = (items: readonly ComposerItem[]): string => {
  const lines: string[] = [];

  for (const item of items) {
    const note = item.note.trim();
    if (note.length === 0) continue;

    const anchor = itemAnchorLabel(item);
    lines.push(anchor === undefined ? `- ${note}` : `- ${note} — ${anchor}`);
  }

  return lines.join('\n');
};

/** Whether a send with these items carries any words of its own. */
export const stackHasWords = (items: readonly ComposerItem[]): boolean =>
  items.some((item) => item.note.trim().length > 0);
