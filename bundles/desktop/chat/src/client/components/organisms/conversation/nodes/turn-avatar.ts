/**
 * The mark a turn wears in the conversation's left gutter: the reader's
 * initials over a tone of their name, or the agent's glyph. The mark is drawn
 * by the turn block's own pseudo-elements — the CSS in `styles.css`; the
 * reader's by `::after`, leaving the prompt's `::before` to its placeholder —
 * from the attributes and custom properties this module writes into the
 * block's element, so the text column and the footer's place never move.
 *
 * The initials and the tone are stated once, in `utility/identity-mark`, and
 * shared with the composer's stack.
 */

import {
  type AuthorRole,
  READER_NAME,
} from '../../../../domain/conversation-authors.js';
import {
  identityRing,
  identityTone,
  initials,
} from '../../../../utility/identity-mark.js';

/**
 * The agent's face: the off-white circle the agent wears, where the reader
 * wears their initials.
 */
const AGENT_FACE = 'oklch(0.98 0 0)';

/**
 * The agent's rim: its own face, tamed toward the surface only enough to read as
 * an edge against it.
 */
const AGENT_RING = `color-mix(in oklch, ${AGENT_FACE} 80%, var(--background))`;

/**
 * The agent's glyph: the bot it fills its face with, drawn as a mask so it takes
 * the surface's colour wherever the circle sits, light or dark.
 */
const AGENT_MARK = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
)}")`;

/** The mark a turn wears: who wrote it, or `null` for a block that wears none. */
export type TurnAvatar = {
  readonly role: AuthorRole;
  readonly name: string;
} | null;

/**
 * The reader's own mark: the one the prompt and the stack that opens it wear,
 * the way the turn the reader sent wears it.
 */
export const READER_AVATAR: TurnAvatar = { role: 'user', name: READER_NAME };

/**
 * Whether two marks are the same, so a block that already wears one is not
 * repainted by a sync that says nothing new.
 */
export const sameTurnAvatar = (left: TurnAvatar, right: TurnAvatar): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.role === right.role &&
    left.name === right.name);

/**
 * Writes the mark a turn wears into the turn block's own element: the
 * attributes and custom properties its pseudo-elements read. The element is
 * never rebuilt, so a transcript update that only changes the time keeps the
 * block it already drew. Idempotent, and it cleans whatever a previous call
 * left behind.
 */
export const applyTurnAvatar = (dom: HTMLElement, avatar: TurnAvatar): void => {
  const { style } = dom;
  dom.removeAttribute('data-turn-avatar');
  dom.removeAttribute('data-avatar-initials');
  style.removeProperty('--turn-avatar-tone');
  style.removeProperty('--turn-avatar-face');
  style.removeProperty('--turn-avatar-ring');
  style.removeProperty('--turn-avatar-mark');
  if (avatar === null) return;

  dom.setAttribute('data-turn-avatar', avatar.role);
  if (avatar.role === 'agent') {
    style.setProperty('--turn-avatar-face', AGENT_FACE);
    style.setProperty('--turn-avatar-ring', AGENT_RING);
    style.setProperty('--turn-avatar-mark', AGENT_MARK);
    return;
  }
  dom.setAttribute('data-avatar-initials', initials(avatar.name));
  style.setProperty('--turn-avatar-tone', identityTone(avatar.name));
  style.setProperty('--turn-avatar-ring', identityRing(avatar.name));
};
