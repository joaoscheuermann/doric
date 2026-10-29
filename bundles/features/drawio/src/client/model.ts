// What the client reads of a revision's `mxfile` (spec "Âncora", "O node
// mostra a revisão" step 4): its pages and, per page, its shapes and
// connectors with their kinds and labels. Parsed with the client's DOMParser.

import type { DiagramCellAnchor } from '../contracts/index.js';
import { RenderError } from './single-page.js';

/** A shape (`vertex="1"`) or a connector (`edge="1"`). */
export type CellKind = DiagramCellAnchor['cellKind'];

/** One shape or connector of a page. */
export interface DiagramCell {
  /** The cell's `id`: the wrapping `<object>`/`<UserObject>`'s when wrapped, else the `mxCell`'s. */
  readonly id: string;
  readonly kind: CellKind;
  /** `labelTextOf` of the cell's label; '' without text. */
  readonly label: string;
}

/** One page: its vertex and edge cells in document order (the root and layer cells are left out). */
export interface DiagramPage {
  /** The `<diagram id>`. */
  readonly id: string;
  /** The `<diagram name>`; '' when absent. */
  readonly name: string;
  readonly cells: readonly DiagramCell[];
}

/** The pages of an `mxfile`, in document order. */
export interface DiagramModel {
  readonly pages: readonly DiagramPage[];
  /** The number of cells over every page. */
  readonly cellCount: number;
}

/** The longest label an anchor or a model cell carries, in characters. */
export const LABEL_LIMIT = 200;

/**
 * A label's text. Accepts the raw attribute value (the `label` of an
 * `<object>`/`<UserObject>`, else the `mxCell`'s `value`), plain or HTML.
 * Returns it with tags removed (`<br>` and block-element ends become spaces),
 * entities decoded, whitespace runs collapsed to one space, trimmed, and cut
 * to the first LABEL_LIMIT characters. Pure; never throws.
 */
export const labelTextOf: (value: string) => string = (value) => {
  const spaced = value.replace(BREAKS, ' ');
  let text: string;

  try {
    text =
      new DOMParser().parseFromString(spaced, 'text/html').body?.textContent ??
      '';
  } catch {
    text = spaced;
  }

  return text.replace(/\s+/gu, ' ').trim().slice(0, LABEL_LIMIT);
};

/** `<br>` and the end of a block element: each becomes a space in a label's text. */
const BREAKS =
  /<br\s*\/?>|<\/(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)\s*>/giu;

const WRAPPERS = new Set(['object', 'UserObject']);

const invalid = (message: string): RenderError =>
  new RenderError('invalid-xml', message);

/**
 * The pages, cells, kinds and labels of a normalized (uncompressed) `mxfile`.
 * Only `mxCell`s with `vertex="1"` or `edge="1"` are cells; everything else
 * (the root `0`, layers such as `1`) is left out. Pure.
 *
 * Throws `RenderError('invalid-xml')` for a parse error, a root that is not
 * `mxfile`, or a `<diagram>` without an `mxGraphModel`.
 */
export const diagramModelOf: (xml: string) => DiagramModel = (xml) => {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  const root = parsed.documentElement;

  if (parsed.getElementsByTagName('parsererror').length > 0) {
    throw invalid('The diagram is not well-formed XML.');
  }
  if (root?.localName !== 'mxfile') {
    throw invalid('The diagram root is not <mxfile>.');
  }

  const pages = [...root.children]
    .filter((child) => child.localName === 'diagram')
    .map((diagram): DiagramPage => {
      const model = diagram.getElementsByTagName('mxGraphModel')[0];

      if (model === undefined) {
        throw invalid('A diagram page has no <mxGraphModel>.');
      }

      return {
        id: diagram.getAttribute('id') ?? '',
        name: diagram.getAttribute('name') ?? '',
        cells: cellsOf(model),
      };
    });

  return {
    pages,
    cellCount: pages.reduce((count, page) => count + page.cells.length, 0),
  };
};

/** The vertex and edge cells of one `mxGraphModel`, in document order. */
const cellsOf = (model: Element): DiagramCell[] => {
  const cells: DiagramCell[] = [];

  for (const cell of model.getElementsByTagName('mxCell')) {
    const kind: CellKind | undefined =
      cell.getAttribute('vertex') === '1'
        ? 'vertex'
        : cell.getAttribute('edge') === '1'
          ? 'edge'
          : undefined;

    if (kind === undefined) continue;

    const wrapper = cell.parentElement;
    const wrapped = wrapper !== null && WRAPPERS.has(wrapper.localName);
    const owner = wrapped ? wrapper : cell;

    cells.push({
      id: owner.getAttribute('id') ?? '',
      kind,
      label: labelTextOf(
        (wrapped ? owner.getAttribute('label') : cell.getAttribute('value')) ??
          '',
      ),
    });
  }

  return cells;
};
