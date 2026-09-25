import { statusCue, type TurnRole } from '@/domain/conversation';
import type { PromptStatus } from '@/domain/projector';
import { setDOMUnmanaged } from 'lexical';

import { statusDot } from './status-dot';

/**
 * A turn's chrome: the avatar, the label naming another Thread's words, and the cue
 * that says the turn is still working. It is deliberately **not** content — DOM the
 * turn owns outside the range Lexical manages (see the turn's `getDOMSlot`) — so it
 * is in no node, no serialization and no copy, nothing can delete it, and the caret
 * has no position to stop in.
 *
 * It lives apart from the node that wears it because it is one concern with its own
 * DOM, and because the node has to be able to put it back: a row that lost its
 * chrome is not the row the log built, and a composer that lost its chrome must not
 * lose the words being written in it.
 */
export type TurnChromeShape = {
  readonly role: TurnRole;
  readonly draft: boolean;
  readonly dimmed: boolean;
  readonly status: PromptStatus;
  readonly label?: string;
};

/** Where each turn's managed children live, keyed by the turn's own DOM. */
const bodies = new WeakMap<HTMLElement, HTMLElement>();

const BODY = 'data-doric-body';
const CHROME = 'data-doric-chrome';
const LABEL = 'data-doric-label';
const ROW = 'data-doric-row';

/** The avatar a turn wears: the person's identicon, or the agent's glyph. */
const avatar = (role: TurnRole): HTMLElement => {
  const mark = document.createElement('span');
  mark.className = 'doric-avatar';
  mark.dataset.kind = role;
  if (role === 'agent') {
    const glyph = document.createElement('span');
    glyph.className = 'doric-glyph';
    mark.append(glyph);
  }
  return mark;
};

const piece = (
  tag: string,
  className: string,
  attribute: string,
): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  node.setAttribute(attribute, '');
  return node;
};

/**
 * A decoration Lexical must not treat as a stranger in its own DOM: unmarked, its
 * mutation observer evicts it as unknown DOM. It is also neither typed in nor
 * selected, so a person copying an answer never carries a decoration this surface
 * drew.
 */
const decoration = (node: HTMLElement): HTMLElement => {
  node.contentEditable = 'false';
  node.style.userSelect = 'none';
  setDOMUnmanaged(node);
  return node;
};

/**
 * The turn's DOM: a column that reads as one measure of prose, with the avatar in
 * the gutter beside it and, above both when another Thread wrote the words, the
 * sentence that says so.
 *
 * Nothing here is written by Lexical: the managed children go into the body (see
 * the node's `getDOMSlot`), so the chrome can be repainted — a turn that starts
 * working and then finishes — without touching one content node or the caret
 * inside it.
 */
export const buildTurnDOM = (shape: TurnChromeShape): HTMLElement => {
  const dom = document.createElement('div');
  dom.className = 'doric-turn';

  const body = piece('div', 'doric-body', BODY);
  const row = decoration(piece('div', 'doric-row', ROW));
  row.append(decoration(piece('div', 'doric-chrome', CHROME)), body);
  dom.append(decoration(piece('p', 'doric-label', LABEL)), row);

  bodies.set(dom, body);
  paintTurnChrome(dom, shape);
  return dom;
};

/**
 * The turn's chrome, when its DOM still carries one. A turn whose decoration is
 * gone is not reused: the surface rebuilds it from the log instead of leaving a row
 * with no avatar on screen.
 */
export const turnChromeOf = (dom: HTMLElement | null): HTMLElement | null =>
  dom === null ? null : dom.querySelector<HTMLElement>(`[${CHROME}]`);

/** Where a turn's managed children live, so its node can point Lexical at them. */
export const turnBodyOf = (dom: HTMLElement): HTMLElement | undefined =>
  bodies.get(dom);

/**
 * Writes a turn's chrome — who wrote it, whether it still works, where from — and
 * puts back any piece of it that is missing, which is what lets a turn whose
 * decoration the browser removed stay the turn it is instead of being rebuilt.
 */
export const paintTurnChrome = (
  dom: HTMLElement,
  shape: TurnChromeShape,
): void => {
  dom.dataset.role = shape.role;
  dom.dataset.draft = String(shape.draft);
  dom.dataset.dimmed = String(shape.dimmed);

  const row =
    dom.querySelector<HTMLElement>(`[${ROW}]`) ??
    dom.appendChild(decoration(piece('div', 'doric-row', ROW)));
  const body = bodies.get(dom) ?? row.querySelector<HTMLElement>(`[${BODY}]`);
  const chrome =
    turnChromeOf(dom) ?? decoration(piece('div', 'doric-chrome', CHROME));
  if (chrome.parentElement !== row) row.prepend(chrome);
  if (body !== null && body.parentElement !== row) row.append(body);

  const cue = statusCue(shape.role, shape.status);
  chrome.replaceChildren(avatar(shape.role));
  if (cue !== undefined) chrome.append(statusDot(cue.label, cue.tone));
  chrome.dataset.status = cue?.tone ?? 'settled';

  const label = dom.querySelector<HTMLElement>(`[${LABEL}]`);
  const drawn = label ?? decoration(piece('p', 'doric-label', LABEL));
  if (label === null) dom.prepend(drawn);
  drawn.textContent = shape.label ?? '';
  drawn.hidden = shape.label === undefined;
};
