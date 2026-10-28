// Anchors for preview comments: how a clicked element of the preview becomes
// a `CommentAnchor`. The preview renders in its own frame, so the element
// reaches the app as a serialized scene node (`scene-graph.ts`): its tag, `id`
// and classes give the CSS `selector`, its own origin stamp
// (`data-papercraft-source`, which the builder writes) the `source` form —
// the file the element came from — and its text excerpt the identity a later
// revision re-resolves it by.

import {
  ARTIFACT_TARGET_KIND,
  type CommentAnchor,
  type CommentTarget,
} from '../contracts/index.js';
import {
  nodeLabel,
  type PseudoKind,
  type SceneNode,
  stampOf,
} from './surface/scene-graph.js';

/** The origin stamp the builder writes on the rendered markup. */
export const STAMP_ATTRIBUTE = 'data-papercraft-source';

/** A simple, stable-enough selector: `tag#id`, `tag.a.b`, else `tag`. */
export const selectorOf = (node: SceneNode): string => nodeLabel(node);

/**
 * Where inside its element a comment was clicked, as fractions of the
 * element's box (`0..1` on each axis): the pin follows the element through
 * layout changes and any pan/zoom. An extra key of the anchor; the forms and
 * their meaning are unchanged.
 */
export interface AnchorOffset {
  readonly x: number;
  readonly y: number;
}

/** The longest text excerpt an anchor records of its element. */
const EXCERPT_LIMIT = 120;

/** An element's text as an anchor records it: whitespace collapsed, short. */
export const excerptOf = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_LIMIT);

/**
 * The anchor a clicked element carries: its own origin stamp, else its
 * selector.
 * `point`, the content point that was clicked, is recorded as the anchor's `x`
 * and `y` (keys every form may carry): where the pin goes on a later revision
 * that no longer has the element. The element's identity beyond its selector
 * goes with it, for a revision whose edited file moved its line: a `text`
 * excerpt and `index`, its ordinal among the elements of its selector (an
 * extra key, like `offset`).
 *
 * `pseudo` names the element's `::before` / `::after` as the thing commented
 * on. The anchor then also carries `pseudo`, and its `label` is the tag plus
 * the pseudo kind (`div::before`). `offset` must then be measured inside the
 * pseudo box, not the host box. The form, `path`/`line`, `selector`, `text`
 * and `index` stay the host element's, so the anchor resolves to the host
 * first. Without `pseudo` the anchor is exactly what it is today, with no
 * `pseudo` key. Never throws.
 */
export const anchorOf = (
  node: SceneNode,
  offset?: AnchorOffset,
  point?: { readonly x: number; readonly y: number },
  index?: number,
  pseudo?: PseudoKind,
): CommentAnchor => {
  const stamp = node.source;
  const text = excerptOf(node.text);
  const label = `${node.tag}${pseudo ?? ''}`;
  const at = {
    ...(pseudo === undefined ? {} : { pseudo }),
    ...(text === '' ? {} : { text }),
    ...(index === undefined ? {} : { index }),
    ...(offset === undefined ? {} : { offset }),
    ...(point === undefined ? {} : { x: point.x, y: point.y }),
  };

  if (stamp !== undefined && stamp !== '') {
    const { path, line } = stampOf(stamp);

    return {
      form: 'source',
      path,
      ...(line === undefined ? {} : { line }),
      selector: selectorOf(node),
      label,
      ...at,
    };
  }

  return {
    form: 'selector',
    selector: selectorOf(node),
    label,
    ...at,
  };
};

/** The offset an anchor recorded inside its element, when it is a valid one. */
export const offsetOf = (anchor: CommentAnchor): AnchorOffset | undefined => {
  const offset = (anchor as { readonly offset?: unknown }).offset as
    | { readonly x?: unknown; readonly y?: unknown }
    | undefined;

  return typeof offset?.x === 'number' && typeof offset.y === 'number'
    ? { x: offset.x, y: offset.y }
    : undefined;
};

/** The ordinal an anchor recorded among its selector's elements, when valid. */
export const indexOf = (anchor: CommentAnchor): number | undefined => {
  const index = (anchor as { readonly index?: unknown }).index;

  return typeof index === 'number' && Number.isInteger(index) && index >= 0
    ? index
    : undefined;
};

/**
 * The pseudo-element an anchor recorded, when it is a valid one: exactly
 * `'::before'` or `'::after'`. Undefined when the key is absent or holds
 * anything else (an anchor from an older revision, or a foreign value).
 * Never throws.
 */
export const pseudoOf = (anchor: CommentAnchor): PseudoKind | undefined => {
  const pseudo: unknown = anchor.pseudo;

  return pseudo === '::before' || pseudo === '::after' ? pseudo : undefined;
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
  nearest?: SceneNode,
): CommentAnchor => ({
  form: 'point',
  x: point.x,
  y: point.y,
  ...(nearest === undefined
    ? {}
    : { selector: selectorOf(nearest), label: nearest.tag }),
});
