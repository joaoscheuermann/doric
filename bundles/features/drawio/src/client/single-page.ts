// `singlePageOf` and `RenderError`, apart from the renderer. This module
// imports nothing, so the e2e can bundle it alone (esbuild, IIFE) and run the
// real function under Chromium's `DOMParser`; `renderer.ts` re-exports both.

/**
 * Why a draw or a measure failed:
 * - `invalid-xml`: the diagram's XML (or the page asked for) is not one the
 *   editor draws — a retry with the same input fails the same way;
 * - `unavailable`: the hidden editor or the measure frame did not answer
 *   (timeout, restart, closed, off-schema answer) — a retry may succeed.
 */
export type RenderErrorCode = 'invalid-xml' | 'unavailable';

/**
 * The one rejection reason of `singlePageOf`, `renderDiagram`,
 * `measureDiagram` and `drawPage`. `code` is fixed at construction; `cause`,
 * when given, is the underlying error (a `DrawioError`, a parse error, …).
 */
export class RenderError extends Error {
  readonly code: RenderErrorCode;

  constructor(code: RenderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RenderError';
    this.code = code;
  }
}

/**
 * The `mxfile` with page `pageId` only (absent: the first `<diagram>`).
 *
 * Accepts a normalized, uncompressed `mxfile` (as a revision stores it).
 * Returns an XML string whose root `<mxfile>` has the source root's
 * attributes minus `pages`, and whose single child is the page's `<diagram>`
 * copied whole — same `id`, same `name`, same `mxGraphModel`, so its
 * serialization equals the source `<diagram>`'s. Parses with `DOMParser`
 * (`application/xml`) and serializes with `XMLSerializer` of the current
 * global scope. Pure apart from those; never mutates its input.
 *
 * Throws `RenderError('invalid-xml')` for a parse error, a root that is not
 * `mxfile`, an `mxfile` without `<diagram>`, or a `pageId` no `<diagram>` has.
 */
export const singlePageOf: (xml: string, pageId?: string) => string = (
  xml,
  pageId,
) => {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  const root = parsed.documentElement;

  if (parsed.getElementsByTagName('parsererror').length > 0) {
    throw new RenderError('invalid-xml', 'The diagram is not well-formed XML.');
  }
  if (root?.localName !== 'mxfile') {
    throw new RenderError('invalid-xml', 'The diagram root is not <mxfile>.');
  }

  const page = [...root.children].find(
    (child) =>
      child.localName === 'diagram' &&
      (pageId === undefined || child.getAttribute('id') === pageId),
  );

  if (page === undefined) {
    throw new RenderError(
      'invalid-xml',
      pageId === undefined
        ? 'The diagram has no page.'
        : `The diagram has no page "${pageId}".`,
    );
  }

  const single = parsed.createElementNS(root.namespaceURI, 'mxfile');

  for (const attribute of [...root.attributes]) {
    if (attribute.name !== 'pages') {
      single.setAttribute(attribute.name, attribute.value);
    }
  }
  single.appendChild(page);

  return new XMLSerializer().serializeToString(single);
};
