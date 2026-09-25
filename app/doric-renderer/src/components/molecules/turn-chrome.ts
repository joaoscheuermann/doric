import { statusCue, type TurnRole } from '@/domain/conversation';
import type { PromptStatus } from '@/domain/projector';
import { setDOMUnmanaged } from 'lexical';

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

/**
 * A lucide icon's own geometry: one `[tag, attributes]` pair per shape it draws,
 * the same `IconNode` shape the package uses. The values are copied from
 * `lucide-react` v0.544.0, whose exported components keep them in a
 * module-private `__iconNode` — reaching that would mean importing from the
 * package's `dist/`, which a browser bundle should not do — so the icons the
 * surface draws are inlined here instead.
 */
export type LucideShape = readonly [string, Readonly<Record<string, string>>];

/**
 * The agent's mark: the robot, at the same 24-unit grid the rest of the surface's
 * icons use. It is the one icon that is not a lucide shape, so its geometry is
 * written here as strokes: two eyes under a rounded head, with the antenna and the
 * ears that make it read as a machine rather than a face.
 */
const ROBOT: readonly LucideShape[] = [
  ['path', { d: 'M12 8V4H8' }],
  ['rect', { width: '16', height: '12', x: '4', y: '8', rx: '2' }],
  ['path', { d: 'M2 14h2' }],
  ['path', { d: 'M20 14h2' }],
  ['path', { d: 'M15 13v2' }],
  ['path', { d: 'M9 13v2' }],
];

/**
 * Draws a lucide icon as an inline `<svg>`: a turn's chrome is raw DOM, not a
 * React node, so it cannot mount the package's component and its geometry is
 * written with `createElementNS` instead. The viewBox and the strokes travel on
 * the element, so the shape scales and paints on its own; `styles.css` only has
 * to size and colour it.
 */
export const lucideIcon = (
  shapes: readonly LucideShape[],
  className: string,
  size: string,
): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) {
      shape.setAttribute(name, value);
    }
    svg.append(shape);
  }
  return svg;
};

/**
 * What a turn's mark stands for, which is not quite its role: the composer is a
 * person's turn too, but it is the one they write in, so it reads apart from the
 * turns they have already sent.
 */
type TurnKind = 'answer' | 'composer' | 'past';

/**
 * The icon each kind of turn wears. Only an agent's turn is an icon: a person's
 * turns — the composer and the ones they already sent — wear the image the app
 * ships for them, painted by the stylesheet, so a person always looks like the same
 * person in every place they appear.
 */
const AVATAR_ICON: Readonly<
  Record<Exclude<TurnKind, 'past' | 'composer'>, readonly LucideShape[]>
> = { answer: ROBOT };

/** The kind of turn a shape describes, from the two fields the chrome carries. */
const turnKind = (shape: TurnChromeShape): TurnKind => {
  if (shape.draft) return 'composer';
  return shape.role === 'agent' ? 'answer' : 'past';
};

/**
 * The avatar a turn wears. Its element keeps the `doric-avatar` class and the
 * `data-kind` the surface finds a turn's chrome by, and gains the `data-turn` the
 * stylesheet reads; an agent's mark is an icon the chrome draws itself, and a
 * person's is left empty for the stylesheet to paint with the image the app ships.
 */
const avatar = (shape: TurnChromeShape): HTMLElement => {
  const mark = document.createElement('span');
  const kind = turnKind(shape);
  mark.className = 'doric-avatar';
  mark.dataset.kind = shape.role;
  mark.dataset.turn = kind;
  if (kind === 'answer') {
    mark.append(lucideIcon(AVATAR_ICON.answer, 'doric-icon', '1rem'));
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
 * DOM Lexical must not treat as a stranger in its own DOM: unmarked, its mutation
 * observer evicts it as unknown DOM.
 */
const unmanaged = <Element extends HTMLElement>(node: Element): Element => {
  setDOMUnmanaged(node);
  return node;
};

/**
 * A piece of chrome: unmanaged, and neither typed in nor selected, so a person
 * copying an answer never carries a decoration this surface drew.
 *
 * Chrome is sealed this way and the row that *holds* the turn's body is not, which
 * is the whole difference: `contenteditable="false"` applies to a whole subtree, so
 * sealing the row would make everything inside it — the words themselves —
 * uneditable, and the caret would have nowhere to stand.
 */
const sealed = <Element extends HTMLElement>(node: Element): Element => {
  node.contentEditable = 'false';
  node.style.userSelect = 'none';
  return unmanaged(node);
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
  const row = unmanaged(piece('div', 'doric-row', ROW));
  row.append(sealed(piece('div', 'doric-chrome', CHROME)), body);
  dom.append(sealed(piece('p', 'doric-label', LABEL)), row);

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
    unmanaged(dom.appendChild(piece('div', 'doric-row', ROW)));
  const body = bodies.get(dom) ?? row.querySelector<HTMLElement>(`[${BODY}]`);
  const chrome =
    turnChromeOf(dom) ?? sealed(piece('div', 'doric-chrome', CHROME));
  if (chrome.parentElement !== row) row.prepend(chrome);
  if (body !== null && body.parentElement !== row) row.append(body);

  const cue = statusCue(shape.role, shape.status);
  // A turn's state is not drawn: the surface stays minimal, and what a state would
  // have said is carried on the chrome itself, where a reader can still find it.
  chrome.replaceChildren(avatar(shape));
  chrome.dataset.status = cue?.tone ?? 'settled';
  chrome.title = cue?.label ?? '';

  const label = dom.querySelector<HTMLElement>(`[${LABEL}]`);
  const drawn = label ?? sealed(piece('p', 'doric-label', LABEL));
  if (label === null) dom.prepend(drawn);
  drawn.textContent = shape.label ?? '';
  drawn.hidden = shape.label === undefined;
};
