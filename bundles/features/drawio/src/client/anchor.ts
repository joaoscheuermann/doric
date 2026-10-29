// The anchor of a diagram comment (spec "Âncora"): its selector, the
// hit-test that builds it on the page on screen, and the re-anchoring that
// places a stored anchor on a revision's page.

import type { CanvasHitTester, ContentPoint } from 'desktop/ui/canvas';

import type {
  DiagramAnchor,
  DiagramLayout,
  DiagramLayoutCell,
} from '../contracts/index.js';
import type { DiagramCell, DiagramPage } from './model.js';

/** `page/<pageId>/cell/<cellId>`, the ids verbatim. Pure. */
export const cellSelectorOf: (pageId: string, cellId: string) => string = (
  pageId,
  cellId,
) => `page/${pageId}/cell/${cellId}`;

/** `page/<pageId>/point/<Math.round(x)>,<Math.round(y)>`. Pure. */
export const pointSelectorOf: (pageId: string, x: number, y: number) => string =
  (pageId, x, y) => `page/${pageId}/point/${Math.round(x)},${Math.round(y)}`;

/** What a selector names: a cell of a page, or a point of a page. */
export type ParsedSelector =
  | { readonly pageId: string; readonly cellId: string }
  | { readonly pageId: string; readonly point: ContentPoint };

/**
 * Reads a selector: the page is the non-empty text between `page/` and the
 * next `/`; then `/cell/` and a non-empty cell id running to the end (it may
 * hold `/`), or `/point/` and two integers `x,y`. Anything else — another
 * prefix, an empty id, a non-integer coordinate, trailing text after a point
 * — answers undefined. Pure; never throws.
 */
export const parseDiagramSelector: (
  selector: string,
) => ParsedSelector | undefined = (selector) => {
  const match = SELECTOR.exec(selector);

  if (match === null) return undefined;

  const [, pageId = '', cellId, x, y] = match;

  return cellId !== undefined
    ? { pageId, cellId }
    : { pageId, point: { x: Number(x), y: Number(y) } };
};

const SELECTOR = /^page\/([^/]+)\/(?:cell\/(.+)|point\/(-?\d+),(-?\d+))$/su;

/**
 * A stored anchor (as `comments/v1.list` or the Thread log carries it) when
 * it is one of this kind's two shapes, else undefined:
 * - a cell anchor: `form: 'selector'`, a cell selector, a string `label`,
 *   finite `x`/`y`, `cellKind` `vertex`|`edge` and an integer `index` ≥ 0;
 * - a free-point anchor: `form: 'selector'`, a point selector, a string
 *   `label`, finite `x`/`y`, and no `cellKind`.
 * Extra keys are tolerated and dropped. Pure; never throws.
 */
export const diagramAnchorOf: (value: unknown) => DiagramAnchor | undefined = (
  value,
) => {
  if (typeof value !== 'object' || value === null) return undefined;

  const { form, selector, label, x, y, cellKind, index } = value as Record<
    string,
    unknown
  >;

  if (
    form !== 'selector' ||
    typeof selector !== 'string' ||
    typeof label !== 'string' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return undefined;
  }

  const parsed = parseDiagramSelector(selector);
  const point = {
    form: 'selector' as const,
    selector,
    label,
    x: x as number,
    y: y as number,
  };

  if (parsed === undefined) return undefined;
  if ('point' in parsed) return cellKind === undefined ? point : undefined;
  if (
    (cellKind === 'vertex' || cellKind === 'edge') &&
    Number.isInteger(index) &&
    (index as number) >= 0
  ) {
    return { ...point, cellKind, index: index as number };
  }

  return undefined;
};

/** What the hit-test and the placement read of the page on screen. */
export interface DiagramView {
  /** The id of the page on screen. */
  readonly pageId: string;
  /** The revision's page ids, in order (absent while the XML is unread). */
  readonly pageIds?: readonly string[];
  /** The model of the page on screen (absent while the XML is unread, e.g. unleased). */
  readonly page?: DiagramPage;
  /** The measured layout of the page on screen. */
  readonly layout: DiagramLayout;
}

/**
 * The comment hit-test of the page on screen. Targets are the page's model
 * cells (vertices and edges) that have a box in the layout; layout boxes of
 * other ids (the root, layers) are never targets. Without `view.page` there
 * are no targets.
 *
 * - `targetAt(pointer, mode)`: in both modes, among the targets whose box
 *   contains `pointer.content` (edges included), the one of smallest area,
 *   ties to the last in document order; none, undefined.
 * - `anchorAt(pointer, targetId)`: for a target id, the cell anchor —
 *   `cellSelectorOf(pageId, id)`, the cell's label, the box centre as
 *   `x`/`y`, its `cellKind`, and `index` among the page's cells of the same
 *   kind and label in document order. Otherwise (undefined or not a
 *   target), the free-point anchor at `pointer.content` —
 *   `pointSelectorOf(pageId, x, y)`, exact `x`/`y`, and the label of the
 *   target whose box centre is nearest ('' without targets).
 *
 * Pure over `view`; never throws.
 */
export const diagramHitTester: (
  view: DiagramView,
) => CanvasHitTester<DiagramAnchor> = (view) => {
  const targets = targetsOf(view);
  const byId = new Map<string, Target>(
    targets.map((target) => [target.cell.id, target]),
  );

  return {
    targetAt: ({ content }) => {
      let found: Target | undefined;

      for (const target of targets) {
        if (!contains(target.box, content)) continue;
        if (found === undefined || area(target.box) <= area(found.box)) {
          found = target;
        }
      }

      return found?.cell.id;
    },
    anchorAt: ({ content }, targetId) => {
      const target = targetId === undefined ? undefined : byId.get(targetId);

      if (target === undefined) {
        return {
          form: 'selector',
          selector: pointSelectorOf(view.pageId, content.x, content.y),
          label: nearest(targets, content)?.cell.label ?? '',
          x: content.x,
          y: content.y,
        };
      }

      const { cell } = target;
      const centre = centreOf(target.box);

      return {
        form: 'selector',
        selector: cellSelectorOf(view.pageId, cell.id),
        label: cell.label,
        x: centre.x,
        y: centre.y,
        cellKind: cell.kind,
        index: targets
          .filter(
            (other) =>
              other.cell.kind === cell.kind && other.cell.label === cell.label,
          )
          .indexOf(target),
      };
    },
  };
};

/** A model cell of the page on screen and its box in the layout. */
interface Target {
  readonly cell: DiagramCell;
  readonly box: DiagramLayoutCell;
}

/** The page's model cells that have a box, in document order (the first box of an id). */
const targetsOf = (view: DiagramView): Target[] => {
  const boxes = new Map<string, DiagramLayoutCell>();

  for (const box of view.layout.cells) {
    if (!boxes.has(box.id)) boxes.set(box.id, box);
  }

  return (view.page?.cells ?? []).flatMap((cell) => {
    const box = boxes.get(cell.id);

    return box === undefined ? [] : [{ cell, box }];
  });
};

const contains = (box: DiagramLayoutCell, point: ContentPoint): boolean =>
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height;

const area = (box: DiagramLayoutCell): number => box.width * box.height;

const centreOf = (box: DiagramLayoutCell): ContentPoint => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/** The target whose box centre is nearest `point`; the first on a tie. */
const nearest = (
  targets: readonly Target[],
  point: ContentPoint,
): Target | undefined => {
  let found: Target | undefined;
  let best = Number.POSITIVE_INFINITY;

  for (const target of targets) {
    const centre = centreOf(target.box);
    const distance = Math.hypot(centre.x - point.x, centre.y - point.y);

    if (distance < best) {
      best = distance;
      found = target;
    }
  }

  return found;
};

/** Where a stored anchor's pin goes on the page on screen. */
export interface AnchorPlacement {
  /** The pin's content point. */
  readonly point: ContentPoint;
  /** The cell the pin sits on, when rule 1 or 2 (or the unleased lookup) placed it. */
  readonly cellId?: string;
  /** Rule 1 found the cell but its label differs from the anchor's ("célula alterada"). */
  readonly changed?: boolean;
}

/**
 * Re-anchors a stored anchor on the page on screen (spec "Âncora"). A model
 * cell counts only when the layout has its box; "centre" is its box centre.
 *
 * - The anchor's page is not `view.pageId` → undefined, a detached pin. This
 *   holds whether that page is missing from the revision or is another page
 *   of it (Q1): the canvas shows one page.
 * - A free point → its `x`, `y`.
 * - A cell anchor, with `view.page`:
 *   1. a cell with the anchor's id and `cellKind` → its centre, `cellId`,
 *      and `changed: true` exactly when its label differs from the anchor's;
 *   2. else the cells of the same `cellKind` and label → the one at the
 *      anchor's `index` among them, else (index out of range) the one whose
 *      centre is nearest the anchor's `x`, `y`;
 *   3. else the anchor's `x`, `y`, no `cellId` (a loose pin on the page).
 * - A cell anchor without `view.page` (unleased) → the centre of the layout
 *   box with the anchor's cell id (`cellId` set, never `changed`), else the
 *   anchor's `x`, `y`.
 *
 * Pure; never throws.
 */
export const placeAnchor: (
  anchor: DiagramAnchor,
  view: DiagramView,
) => AnchorPlacement | undefined = (anchor, view) => {
  const parsed = parseDiagramSelector(anchor.selector);

  if (parsed === undefined || !isShownPage(parsed.pageId, view)) {
    return undefined;
  }

  const own = { x: anchor.x, y: anchor.y };

  if (!('cellKind' in anchor) || 'point' in parsed) return { point: own };

  if (view.page === undefined) {
    const box = view.layout.cells.find((cell) => cell.id === parsed.cellId);

    return box === undefined
      ? { point: own }
      : { point: centreOf(box), cellId: box.id };
  }

  const targets = targetsOf(view);
  const same = targets.find(
    ({ cell }) => cell.id === parsed.cellId && cell.kind === anchor.cellKind,
  );

  if (same !== undefined) {
    return {
      point: centreOf(same.box),
      cellId: same.cell.id,
      ...(same.cell.label === anchor.label ? {} : { changed: true }),
    };
  }

  const twins = targets.filter(
    ({ cell }) => cell.kind === anchor.cellKind && cell.label === anchor.label,
  );
  const twin = twins[anchor.index] ?? nearest(twins, own);

  return twin === undefined
    ? { point: own }
    : { point: centreOf(twin.box), cellId: twin.cell.id };
};

/**
 * Whether a pin on page `pageId` shows on the page on screen (Q1): only the
 * page on screen itself. A page missing from the revision and another page
 * of it are both detached.
 */
const isShownPage = (pageId: string, view: DiagramView): boolean =>
  pageId === view.pageId;
