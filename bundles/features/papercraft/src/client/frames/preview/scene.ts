// The preview frame's scene: the tree of what the revision rendered, derived
// from the frame's own DOM and measured in the frame's CSS pixels, then
// serialized as `SceneNodeData` for the app (frame-protocol.ts).
//
// The derivation is the one the surface made inside its shadow root:
// element children in document order, `style`/`link`/`script`/`meta`/`title`
// skipped, at most SCENE_NODE_LIMIT nodes, ids `n0`, `n1`, … in that order.
// A node carries its own origin stamp only; the app walks stamps down to the
// unstamped descendants.
//
// Bounds are an element's border box cut to what its clipping ancestors
// leave visible, in document coordinates (the frame's top-left corner, its
// scroll added back). There is no scale: the app scales the whole iframe.
// The out-of-flow `::before` / `::after` boxes are measured apart, as targets
// of their own.

import { NODE_TEXT_LIMIT, SCENE_NODE_LIMIT } from '../../frame-constants.js';
import type { PseudoKind, Rect, SceneNodeData } from '../../frame-protocol.js';

/** The attribute a stamped element carries its `path:line` origin in. */
export const STAMP_ATTRIBUTE = 'data-papercraft-source';

const SKIP_TAGS = new Set(['STYLE', 'LINK', 'SCRIPT', 'META', 'TITLE']);

const PSEUDO_KINDS: readonly PseudoKind[] = ['::before', '::after'];

/** One derived element, with the element itself, kept inside the frame. */
export interface FrameNode {
  readonly data: SceneNodeData;
  readonly element: Element;
}

export interface FrameScene {
  readonly nodes: readonly FrameNode[];
  readonly byElement: ReadonlyMap<Element, FrameNode>;
  readonly byId: ReadonlyMap<string, FrameNode>;
}

type StyleOf = (element: Element, pseudo?: PseudoKind) => CSSStyleDeclaration;

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

/** A rect the protocol accepts: finite, with no negative size. */
const sane = (rect: Rect): Rect => ({
  x: finiteOr(rect.x, 0),
  y: finiteOr(rect.y, 0),
  width: Math.max(0, finiteOr(rect.width, 0)),
  height: Math.max(0, finiteOr(rect.height, 0)),
});

const boxOf = (element: Element): Rect => {
  const rect = element.getBoundingClientRect();

  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
};

/** An ancestor that hides its overflow: its box, and the axes it clips on. */
interface Clip {
  readonly box: Rect;
  readonly x: boolean;
  readonly y: boolean;
}

/** Whether a resolved `overflow-*` value clips (an unresolved one does not). */
const clips = (value: string): boolean =>
  value === 'hidden' ||
  value === 'clip' ||
  value === 'scroll' ||
  value === 'auto';

const isStatic = (position: string): boolean =>
  position === '' || position === 'static';

const clipBounds = (bounds: Rect, list: readonly Clip[]): Rect => {
  if (list.length === 0) return bounds;

  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;

  for (const clip of list) {
    if (clip.x) {
      left = Math.max(left, clip.box.x);
      right = Math.min(right, clip.box.x + clip.box.width);
    }

    if (clip.y) {
      top = Math.max(top, clip.box.y);
      bottom = Math.min(bottom, clip.box.y + clip.box.height);
    }
  }

  // A box clipped out of sight keeps its place but takes no room.
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : { x: bounds.x, y: bounds.y, width: 0, height: 0 };
};

/**
 * The ancestors that clip an element: those that hide their overflow on some
 * axis and lie on its containing-block chain, below the document element. An
 * absolute box escapes the static ancestors below its containing block, a
 * fixed one every ancestor. The body clips only when the document element
 * hides overflow itself; otherwise the body's overflow is the viewport's.
 */
const clipsOf = (element: Element, styleOf: StyleOf): Clip[] => {
  const document = element.ownerDocument;
  const html = document.documentElement;
  const htmlStyle = styleOf(html);
  const bodyClips = clips(htmlStyle.overflowX) || clips(htmlStyle.overflowY);
  const list: Clip[] = [];
  let position = styleOf(element).position;

  for (
    let ancestor = element.parentElement;
    ancestor !== null && ancestor !== html;
    ancestor = ancestor.parentElement
  ) {
    const style = styleOf(ancestor);

    if (position === 'fixed') break;
    if (position === 'absolute' && isStatic(style.position)) continue;

    position = style.position;

    if (ancestor === document.body && !bodyClips) continue;

    const x = clips(style.overflowX);
    const y = clips(style.overflowY);

    if (x || y) list.push({ box: boxOf(ancestor), x, y });
  }

  return list;
};

/** A resolved CSS px length as a number; NaN for anything else (`auto`). */
const pxOf = (value: string): number =>
  value.endsWith('px') ? Number(value.slice(0, -2)) : Number.NaN;

const borderOf = (value: string): number => Number.parseFloat(value) || 0;

const paddingBoxOf = (element: Element, styleOf: StyleOf): Rect => {
  const box = boxOf(element);
  const style = styleOf(element);
  const left = borderOf(style.borderLeftWidth);
  const top = borderOf(style.borderTopWidth);

  return {
    x: box.x + left,
    y: box.y + top,
    width: box.width - left - borderOf(style.borderRightWidth),
    height: box.height - top - borderOf(style.borderBottomWidth),
  };
};

/** The viewport, in client coordinates; `absolute` uses its scrolled origin. */
const viewportBox = (document: Document, scrolled: boolean): Rect => {
  const html = document.documentElement;
  const view = document.defaultView;

  return {
    x: scrolled ? -(view?.scrollX ?? 0) : 0,
    y: scrolled ? -(view?.scrollY ?? 0) : 0,
    width: html.clientWidth,
    height: html.clientHeight,
  };
};

/**
 * The client box of an out-of-flow `::before` / `::after` of `host`, cut to
 * the host's own overflow when the host is its containing block; undefined
 * when the pseudo-element draws no out-of-flow box (no `content`, in flow, or
 * an inset or margin that does not resolve to px).
 */
const pseudoClientBoxOf = (
  host: Element,
  pseudo: PseudoKind,
  styleOf: StyleOf,
): Rect | undefined => {
  const style = styleOf(host, pseudo);

  if (style.content === '' || style.content === 'none') return undefined;
  if (style.content === 'normal') return undefined;
  if (style.position !== 'absolute' && style.position !== 'fixed') {
    return undefined;
  }

  const left = pxOf(style.left) + pxOf(style.marginLeft);
  const top = pxOf(style.top) + pxOf(style.marginTop);
  const right = pxOf(style.right) + pxOf(style.marginRight);
  const bottom = pxOf(style.bottom) + pxOf(style.marginBottom);

  if (![left, top, right, bottom].every(Number.isFinite)) return undefined;

  let block: Element | undefined;

  if (style.position === 'absolute') {
    for (
      let element: Element | null = host;
      element !== null && element !== host.ownerDocument.documentElement;
      element = element.parentElement
    ) {
      if (!isStatic(styleOf(element).position)) {
        block = element;
        break;
      }
    }
  }

  const padding =
    block === undefined
      ? viewportBox(host.ownerDocument, style.position === 'absolute')
      : paddingBoxOf(block, styleOf);
  const box: Rect = {
    x: padding.x + left,
    y: padding.y + top,
    width: padding.width - left - right,
    height: padding.height - top - bottom,
  };

  if (block !== host) return box;

  const own = styleOf(host);
  const x = clips(own.overflowX);
  const y = clips(own.overflowY);

  return x || y ? clipBounds(box, [{ box: padding, x, y }]) : box;
};

/** An element's text, whitespace collapsed, cut to NODE_TEXT_LIMIT. */
const textOf = (element: Element): string => {
  let text = '';

  const walk = (parent: Node): void => {
    for (const child of parent.childNodes) {
      if (text.length > NODE_TEXT_LIMIT) return;

      if (child.nodeType === 3) {
        text = `${text}${(child as Text).data}`
          .replace(/\s+/g, ' ')
          .trimStart();
      } else if (
        child.nodeType === 1 &&
        !SKIP_TAGS.has((child as Element).tagName)
      ) {
        walk(child);
      }
    }
  };

  walk(element);

  return text.trim().slice(0, NODE_TEXT_LIMIT).trimEnd();
};

const classesOf = (element: Element): string[] =>
  (element.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter((name) => name !== '' && name.length <= 256)
    .slice(0, 64);

const attributeWithin = (
  element: Element,
  name: string,
  limit: number,
): string | undefined => {
  const value = element.getAttribute(name);

  return value === null || value === '' || value.length > limit
    ? undefined
    : value;
};

const hasArea = (rect: Rect): boolean => rect.width > 0 || rect.height > 0;

/**
 * Derives and measures the scene of the elements in `tops` (each a node at
 * depth 0) and their descendants, in document order.
 */
export const deriveScene = (tops: Iterable<Element>): FrameScene => {
  const nodes: FrameNode[] = [];
  const byElement = new Map<Element, FrameNode>();
  const byId = new Map<string, FrameNode>();
  const styles = new Map<Element, Map<string, CSSStyleDeclaration>>();

  const styleOf: StyleOf = (element, pseudo) => {
    let own = styles.get(element);

    if (own === undefined) {
      own = new Map();
      styles.set(element, own);
    }

    const key = pseudo ?? '';
    let style = own.get(key);

    if (style === undefined) {
      const view = element.ownerDocument.defaultView;

      style =
        view?.getComputedStyle(element, pseudo ?? null) ??
        ({ position: 'static' } as CSSStyleDeclaration);
      own.set(key, style);
    }

    return style;
  };

  const view = (() => {
    for (const top of tops) return top.ownerDocument.defaultView;

    return null;
  })();
  const scrollX = view?.scrollX ?? 0;
  const scrollY = view?.scrollY ?? 0;

  /** A client box, cut by `host`'s clipping ancestors, in document px. */
  const toDocument = (box: Rect, host: Element): Rect => {
    const shown = clipBounds(box, clipsOf(host, styleOf));

    return sane({ ...shown, x: shown.x + scrollX, y: shown.y + scrollY });
  };

  const visit = (
    element: Element,
    depth: number,
    parent: FrameNode | undefined,
  ): void => {
    if (nodes.length >= SCENE_NODE_LIMIT) return;
    if (SKIP_TAGS.has(element.tagName)) return;

    const pseudo: { '::before'?: Rect; '::after'?: Rect } = {};

    for (const kind of PSEUDO_KINDS) {
      const box = pseudoClientBoxOf(element, kind, styleOf);
      const shown = box === undefined ? undefined : toDocument(box, element);

      if (shown !== undefined && hasArea(shown)) pseudo[kind] = shown;
    }

    const elementId = attributeWithin(element, 'id', 256);
    const stamp = attributeWithin(element, STAMP_ATTRIBUTE, 1024);
    const data: SceneNodeData = {
      id: `n${String(nodes.length)}`,
      ...(parent === undefined ? {} : { parentId: parent.data.id }),
      depth,
      tag: element.tagName.toLowerCase().slice(0, 64),
      classes: classesOf(element),
      ...(elementId === undefined ? {} : { elementId }),
      ...(stamp === undefined ? {} : { stamp }),
      text: textOf(element),
      bounds: toDocument(boxOf(element), element),
      ...(Object.keys(pseudo).length === 0 ? {} : { pseudo }),
    };
    const node: FrameNode = { data, element };

    nodes.push(node);
    byElement.set(element, node);
    byId.set(data.id, node);

    for (const child of element.children) visit(child, depth + 1, node);
  };

  for (const top of tops) visit(top, 0, undefined);

  return { nodes, byElement, byId };
};

/**
 * The node an event is about: the deepest scene node on its path, the
 * event's target first.
 */
export const nodeOfPath = (
  scene: FrameScene,
  path: readonly EventTarget[],
): FrameNode | undefined => {
  for (const part of path) {
    const node = scene.byElement.get(part as Element);

    if (node !== undefined) return node;
  }

  return undefined;
};

/**
 * Which reported pseudo box of `node` holds the document point, `::after`
 * first since it paints above `::before`; edges inclusive.
 */
export const pseudoAtPoint = (
  node: FrameNode,
  point: { readonly x: number; readonly y: number },
): PseudoKind | undefined =>
  (['::after', '::before'] as const).find((kind) => {
    const box = node.data.pseudo?.[kind];

    return (
      box !== undefined &&
      point.x >= box.x &&
      point.y >= box.y &&
      point.x <= box.x + box.width &&
      point.y <= box.y + box.height
    );
  });
