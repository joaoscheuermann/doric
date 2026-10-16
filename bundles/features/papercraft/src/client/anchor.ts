// Anchors for preview comments: how a clicked element inside the preview's
// shadow root becomes a `CommentAnchor`. The origin stamp the builder writes
// (`data-papercraft-source`) gives the `source` form — the file the element came
// from — and a plain click falls back to a CSS `selector`.

import {
  ARTIFACT_TARGET_KIND,
  type CommentAnchor,
  type CommentTarget,
} from '../contracts/index.js';

/** The origin stamp the builder writes on the rendered markup. */
export const STAMP_ATTRIBUTE = 'data-papercraft-source';

/** A simple, stable-enough selector: `tag#id`, `tag.a.b`, else `tag`. */
export const selectorOf = (element: Element): string => {
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute('id');
  if (id !== null && id !== '') return `${tag}#${id}`;

  const classes = (element.getAttribute('class') ?? '')
    .trim()
    .split(/\s+/)
    .filter((name) => name !== '')
    .slice(0, 2);

  return classes.length === 0 ? tag : `${tag}.${classes.join('.')}`;
};

const stampOf = (
  value: string,
): { readonly path: string; readonly line?: number } => {
  const match = /^(.*?):(\d+)$/.exec(value);
  if (match === null) return { path: value };

  const line = Number(match[2]);

  return Number.isInteger(line) && line > 0
    ? { path: match[1] ?? value, line }
    : { path: value };
};

/** The anchor a clicked element carries: its origin stamp, else its selector. */
export const anchorOf = (element: Element): CommentAnchor => {
  const stamp = element.getAttribute(STAMP_ATTRIBUTE);

  if (stamp !== null && stamp !== '') {
    const { path, line } = stampOf(stamp);

    return {
      form: 'source',
      path,
      ...(line === undefined ? {} : { line }),
      selector: selectorOf(element),
      label: element.tagName.toLowerCase(),
    };
  }

  return {
    form: 'selector',
    selector: selectorOf(element),
    label: element.tagName.toLowerCase(),
    ...(element.textContent ? { text: element.textContent.slice(0, 120) } : {}),
  };
};

/** The anchored target of the preview revision a comment is written against. */
export const targetOf = (
  artifactId: string,
  revision: number,
  anchor: CommentAnchor,
): CommentTarget => ({
  kind: ARTIFACT_TARGET_KIND,
  id: artifactId,
  revision,
  anchor,
});

/**
 * The anchor of a click on empty space: the point still resolves against the
 * derived tree, so the comment keeps the nearest element and the coordinates
 * — the precision that does not force the reader to hit the target.
 */
export const pointAnchorOf = (
  point: { readonly x: number; readonly y: number },
  nearest?: Element,
): CommentAnchor => ({
  form: 'point',
  x: point.x,
  y: point.y,
  ...(nearest === undefined
    ? {}
    : {
        selector: selectorOf(nearest),
        label: nearest.tagName.toLowerCase(),
      }),
});

/** The reading a card shows at the end of its line: `Checkout.tsx:42`, or `espaço em (412, 180)`. */
export const anchorLabelOf = (anchor: CommentAnchor): string => {
  if (anchor.form === 'source' && anchor.path !== undefined)
    return anchor.line === undefined
      ? anchor.path
      : `${anchor.path}:${String(anchor.line)}`;

  if (anchor.form === 'point')
    return `espaço em (${String(anchor.x ?? 0)}, ${String(anchor.y ?? 0)})`;

  return anchor.selector ?? anchor.label ?? anchor.text ?? '';
};
