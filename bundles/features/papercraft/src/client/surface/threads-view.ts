// `threads-view.ts` — how the preview names a thread's anchor: the popover's
// short title and the whole anchor for its tooltip and the copy. The pins, the
// counts and the thread a pin opens are `desktop/ui/canvas`'s. Pure.

import type { CommentAnchor } from '../../contracts/index.js';

/** The component a file names: `src/Checkout.tsx` → `Checkout`. */
const componentOf = (path: string | undefined): string | undefined => {
  if (path === undefined || path === '') return undefined;

  const file = path.split('/').pop() ?? path;
  const dot = file.indexOf('.');

  return dot <= 0 ? file : file.slice(0, dot);
};

/**
 * Where a thread points, short, for the popover's title: `Checkout:42` for a
 * stamped element, `Checkout (412, 180)` for a point — the component read off
 * the anchor's file, else the preview's source.
 */
export const anchorTitleOf = (
  anchor: CommentAnchor,
  source: string | undefined,
): string => {
  const component =
    componentOf(anchor.path) ?? componentOf(source) ?? anchor.label ?? '';

  if (anchor.form === 'point')
    return `${component} (${String(Math.round(anchor.x ?? 0))}, ${String(
      Math.round(anchor.y ?? 0),
    )})`.trim();

  if (anchor.line !== undefined) return `${component}:${String(anchor.line)}`;

  return component === '' ? (anchor.selector ?? anchor.text ?? '') : component;
};

/**
 * The whole anchor, for the title's tooltip and the copy:
 * `path:line · element · rev N`, or `espaço em (x, y) · perto de element · rev N`.
 */
export const anchorTextOf = (
  anchor: CommentAnchor,
  revision: number | undefined,
): string => {
  const element = anchor.selector ?? anchor.label;
  const rev = revision === undefined ? [] : [`rev ${String(revision)}`];

  if (anchor.form === 'point') {
    return [
      `espaço em (${String(Math.round(anchor.x ?? 0))}, ${String(
        Math.round(anchor.y ?? 0),
      )})`,
      ...(element === undefined ? [] : [`perto de ${element}`]),
      ...rev,
    ].join(' · ');
  }

  const where =
    anchor.path === undefined
      ? undefined
      : anchor.line === undefined
        ? anchor.path
        : `${anchor.path}:${String(anchor.line)}`;

  return [
    ...(where === undefined ? [] : [where]),
    ...(element === undefined ? [] : [element]),
    ...(anchor.form === 'range' && anchor.text !== undefined
      ? [`“${anchor.text}”`]
      : []),
    ...rev,
  ].join(' · ');
};
