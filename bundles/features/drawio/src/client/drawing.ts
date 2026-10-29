// Drawing one page for the cache (spec "O node mostra a revisão", step 5):
// render, measure, store. The node takes a `DiagramDrawing` so tests inject
// fakes for the renderer and the measure frame.

import { DrawioClient } from '@drawio/react';

import type {
  DiagramLayout,
  DiagramSvgEntry,
  DiagramSvgKey,
  DiagramTheme,
  DrawioSvg,
} from '../contracts/index.js';
import type { EditorClient, EditorClientOptions } from './editor-frame.js';
import { measureDiagram } from './measure.js';
import { type RenderRequest, renderDiagram } from './renderer.js';

/**
 * The two steps that draw a page (the hidden editor and the measure frame),
 * and the modal's editor client.
 */
export interface DiagramDrawing {
  /** As `renderDiagram`: the SVG text, or a `RenderError`. */
  render(request: RenderRequest): Promise<string>;
  /** As `measureDiagram`: the layout, or a `RenderError`. */
  measure(svg: string, theme: DiagramTheme): Promise<DiagramLayout>;
  /**
   * Creates the modal editor's client over `iframe`, which the client points at
   * `options.url`. Default: `new DrawioClient(iframe, options)`; tests pass a fake.
   */
  createEditorClient(
    iframe: HTMLIFrameElement,
    options: EditorClientOptions,
  ): EditorClient;
}

/**
 * The window's renderer, measurer and editor client:
 * `{ render: renderDiagram, measure: measureDiagram, createEditorClient:
 * (iframe, options) => new DrawioClient(iframe, options) }`.
 */
export const defaultDrawing: DiagramDrawing = {
  render: renderDiagram,
  measure: measureDiagram,
  createEditorClient: (iframe, options) => new DrawioClient(iframe, options),
};

/**
 * The lowercase hex SHA-256 (64 digits) of `text`'s UTF-8 bytes, through
 * `crypto.subtle`. Rejects only when `crypto.subtle` is missing.
 */
export const sha256Hex: (text: string) => Promise<string> = async (text) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

/**
 * Draws page `key.pageId` of `xml` in `key.theme`:
 * `drawing.render({ xml, pageId: key.pageId, theme: key.theme, format: 'svg' })`,
 * then `drawing.measure(svg, key.theme)`, then
 * `store.put({ ...key, svg, layout })` — plus `first: true` exactly when
 * `input.first` is true (the caller says `key.pageId` is the revision's
 * first page) — and resolves with `{ svg, layout }`.
 *
 * `put` is called before the promise resolves and is not awaited; a `put`
 * that throws or rejects is ignored (the page is drawn again on the next
 * mount). Rejects with the `RenderError` of `render` or `measure`, without
 * calling `put`.
 */
export const drawPage: (
  input: {
    readonly key: DiagramSvgKey;
    readonly xml: string;
    /** `key.pageId` is the revision's first `<diagram>`; the put records the pointer. */
    readonly first?: true;
  },
  drawing: Pick<DiagramDrawing, 'render' | 'measure'>,
  store: Pick<DrawioSvg, 'put'>,
) => Promise<DiagramSvgEntry> = async ({ key, xml, first }, drawing, store) => {
  const svg = await drawing.render({
    xml,
    pageId: key.pageId,
    theme: key.theme,
    format: 'svg',
  });
  const layout = await drawing.measure(svg, key.theme);

  try {
    store
      .put({ ...key, svg, layout, ...(first ? { first } : {}) })
      .catch(() => undefined);
  } catch {
    // The page is drawn again on the next mount.
  }

  return { svg, layout };
};
