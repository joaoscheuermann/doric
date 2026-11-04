/**
 * The mark a turn wears in the conversation's left gutter: the reader's
 * initials over a tone of their name, or the icon of the model that answered
 * the agent's turn. The mark is drawn by the turn block's own `::after` — the
 * CSS in `styles.css`, leaving the prompt's `::before` to its placeholder —
 * from the attributes and custom properties this module writes into the
 * block's element, so the text column and the footer's place never move.
 *
 * The initials and the tone are stated once, in `utility/identity-mark`, and
 * shared with the composer's stack.
 */

import { svgMask } from 'desktop/ui/svg-mask';

import {
  type AnsweredBy,
  READER_NAME,
} from '../../../../domain/conversation-authors.js';
import {
  identityRing,
  identityTone,
  initials,
} from '../../../../utility/identity-mark.js';

/**
 * The bot glyph: what an agent mark draws when its answering model is known to
 * have no icon (`fallback`), as a mask in the text colour.
 */
const AGENT_MARK = svgMask(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
);

/** An empty mask: an agent mark that paints nothing yet keeps its box. */
const EMPTY_MARK = svgMask(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>',
);

/**
 * An agent mark's icon: the answering model's SVG, the bot glyph (the icon is
 * known to be absent), or nothing yet (pending, or the read failed).
 */
export type AgentMarkIcon =
  | { readonly kind: 'icon'; readonly svg: string }
  | { readonly kind: 'fallback' }
  | { readonly kind: 'pending' };

/** The icon of each answering model the turns name, by `answeredKey`. */
export type AgentIcons = ReadonlyMap<string, AgentMarkIcon>;

/**
 * The key `AgentIcons` holds an answering model under:
 * `${providerId}\u0000${model}`. Two pairs share a key only when they are equal.
 */
export const answeredKey = (answered: AnsweredBy): string =>
  `${answered.providerId}\u0000${answered.model}`;

/**
 * The mark a turn wears: who wrote it and, for the agent, the icon it draws;
 * `null` for a block that wears none.
 */
export type TurnAvatar =
  | { readonly role: 'user'; readonly name: string }
  | {
      readonly role: 'agent';
      readonly name: string;
      readonly icon: AgentMarkIcon;
    }
  | null;

/**
 * The reader's own mark: the one the prompt and the stack that opens it wear,
 * the way the turn the reader sent wears it.
 */
export const READER_AVATAR: TurnAvatar = { role: 'user', name: READER_NAME };

/**
 * Whether two marks are the same, so a block that already wears one is not
 * repainted by a sync that says nothing new: same role and name and, for two
 * agent marks, the same icon kind and, for `icon`, the same SVG.
 */
export const sameTurnAvatar = (
  left: TurnAvatar,
  right: TurnAvatar,
): boolean => {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (left.role !== right.role || left.name !== right.name) return false;
  if (left.role === 'user' || right.role === 'user') return true;
  return (
    left.icon.kind === right.icon.kind &&
    (left.icon.kind !== 'icon' ||
      (right.icon.kind === 'icon' && left.icon.svg === right.icon.svg))
  );
};

/** The mask an agent mark's icon paints. */
const agentMask = (icon: AgentMarkIcon): string => {
  if (icon.kind === 'icon') return svgMask(icon.svg);
  return icon.kind === 'fallback' ? AGENT_MARK : EMPTY_MARK;
};

/**
 * Writes the mark a turn wears into the turn block's own element: the
 * attributes and custom properties its `::after` reads. The element is never
 * rebuilt, so a transcript update that only changes the time keeps the block
 * it already drew. Idempotent, and it cleans whatever a previous call left
 * behind. An agent's mark is a mask in `--turn-avatar-icon`: the model's SVG,
 * the bot glyph for `fallback`, or an empty mask for `pending`.
 */
export const applyTurnAvatar = (dom: HTMLElement, avatar: TurnAvatar): void => {
  const { style } = dom;
  dom.removeAttribute('data-turn-avatar');
  dom.removeAttribute('data-avatar-initials');
  style.removeProperty('--turn-avatar-tone');
  style.removeProperty('--turn-avatar-ring');
  style.removeProperty('--turn-avatar-icon');
  if (avatar === null) return;

  dom.setAttribute('data-turn-avatar', avatar.role);
  if (avatar.role === 'agent') {
    style.setProperty('--turn-avatar-icon', agentMask(avatar.icon));
    return;
  }
  dom.setAttribute('data-avatar-initials', initials(avatar.name));
  style.setProperty('--turn-avatar-tone', identityTone(avatar.name));
  style.setProperty('--turn-avatar-ring', identityRing(avatar.name));
};
