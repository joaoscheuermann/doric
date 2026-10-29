// The measure frame's runtime (spec "Frame de medida"): it only measures;
// nobody sees it. It imports types (erased) and `frame-constants.ts` only, so
// the frame bundle carries neither zod nor the contracts. The barrier is the
// frame's CSP (no script from the SVG runs, no network); `sanitizeSvg` is a
// list of what goes, not of what stays.

import type {
  DiagramLayout,
  DiagramLayoutCell,
} from '../../../contracts/index.js';
import {
  DIAGRAM_FRAME_PROTOCOL,
  FRAME_ERROR_LIMIT,
} from '../../frame-constants.js';
import type { FrameMessage, RenderMessage } from '../../frame-protocol.js';

/** The frame's window, with its own constructors (`DOMParser`, `MessageChannel`, …). */
export type DiagramFrameWindow = Window & typeof globalThis;

/**
 * Cleans a parsed SVG in place, before it is inserted. Removes, at any depth:
 * - every `script`, `iframe`, `object` and `embed` element;
 * - every `foreignObject` that contains an `img`, `video`, `audio`, `canvas`,
 *   `input`, `textarea`, `select`, `button`, `form`, `link` or `meta`
 *   element (Q3); a `foreignObject` holding only XHTML text markup (`div`,
 *   `span`, `br`, `b`, …, with text and `style`) stays;
 * - every attribute whose name starts with `on` (case-insensitive);
 * - every `href` and `xlink:href` whose value, trimmed, does not start with
 *   `#` or `data:image/`.
 * Everything else stays as it was. Never throws.
 */
export const sanitizeSvg: (svg: Element) => void = (svg) => {
  for (const element of [svg, ...svg.getElementsByTagName('*')]) {
    const name = element.localName.toLowerCase();

    if (
      REMOVED.has(name) ||
      (name === 'foreignobject' && !isTextForeignObject(element))
    ) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (isUnsafeAttribute(attribute)) {
        element.removeAttributeNode(attribute);
      }
    }
  }
};

/** The elements that go wherever they are. */
const REMOVED = new Set(['script', 'iframe', 'object', 'embed']);

/** What a `foreignObject` may not hold (Q3): media, form controls, links to resources. */
const NOT_TEXT = new Set([
  'img',
  'video',
  'audio',
  'canvas',
  'input',
  'textarea',
  'select',
  'button',
  'form',
  'link',
  'meta',
]);

/** Q3: a `foreignObject` stays when it holds only text markup (no NOT_TEXT element). */
const isTextForeignObject = (foreignObject: Element): boolean =>
  ![...foreignObject.getElementsByTagName('*')].some((element) =>
    NOT_TEXT.has(element.localName.toLowerCase()),
  );

/** An `on*` handler, or a link that is neither local (`#`) nor a `data:image/`. */
const isUnsafeAttribute = (attribute: Attr): boolean => {
  if (attribute.name.toLowerCase().startsWith('on')) return true;
  if (attribute.localName !== 'href') return false;

  const value = attribute.value.trim();

  return !value.startsWith('#') && !value.startsWith('data:image/');
};

/**
 * Measures an `<svg>` attached to the frame's document: its `width`/`height`
 * (its bounding box) and one box per descendant with a non-empty `data-cell-id`, in
 * document order, each from `getBoundingClientRect` relative to the svg's own
 * rect. Numbers are clamped to finite values ≥ 0. Reads only.
 */
export const measureSvg: (svg: SVGSVGElement) => DiagramLayout = (svg) => {
  const origin = svg.getBoundingClientRect();
  const cells: DiagramLayoutCell[] = [];

  for (const element of svg.querySelectorAll(
    '[data-cell-id]:not([data-cell-id=""])',
  )) {
    const box = element.getBoundingClientRect();

    cells.push({
      id: element.getAttribute('data-cell-id') ?? '',
      x: size(box.left - origin.left),
      y: size(box.top - origin.top),
      width: size(box.width),
      height: size(box.height),
    });
  }

  return { width: size(origin.width), height: size(origin.height), cells };
};

/** A finite number ≥ 0: anything else is 0. */
const size = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Starts the runtime on the frame's window:
 * - posts `{ drawio: DIAGRAM_FRAME_PROTOCOL, kind: 'hello' }` to
 *   `win.parent` (target origin `*`, the frame's origin is opaque);
 * - takes the port of the first window message `{ drawio:
 *   DIAGRAM_FRAME_PROTOCOL, kind: 'connect' }` that carries one, ignores
 *   later ones, and sends `{ type: 'ready', version: 1 }` on it;
 * - answers each port message that is a `RenderMessage` (`version`
 *   DIAGRAM_FRAME_PROTOCOL) with exactly one message, in order: `rendered`
 *   (parse with `DOMParser` `image/svg+xml`, `sanitizeSvg`, replace the
 *   body's content with it, `measureSvg`) or `error` (a parse error, a root
 *   that is not `<svg>`, a measure that threw), its message cut to
 *   FRAME_ERROR_LIMIT characters. Other port messages are ignored.
 * Never throws.
 */
export const startDiagramFrame: (win: DiagramFrameWindow) => void = (win) => {
  let port: MessagePort | undefined;

  const answer = (message: FrameMessage): void => {
    try {
      port?.postMessage(message);
    } catch {
      // The app closed its end; nobody is left to answer.
    }
  };

  const render = (message: RenderMessage): FrameMessage => {
    try {
      const parsed = new win.DOMParser().parseFromString(
        message.svg,
        'image/svg+xml',
      );
      const error = parsed.getElementsByTagName('parsererror')[0];
      const svg = parsed.documentElement;

      if (error !== undefined) {
        return failure(`The SVG does not parse: ${error.textContent ?? ''}`);
      }
      if (!(svg instanceof win.SVGSVGElement)) {
        return failure('The document root is not <svg>.');
      }

      sanitizeSvg(svg);

      const shown = win.document.adoptNode(svg);

      win.document.documentElement.style.colorScheme = message.theme;
      win.document.body.replaceChildren(shown);

      return { type: 'rendered', ...measureSvg(shown) };
    } catch (error) {
      return failure(
        `The SVG could not be measured: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const onPortMessage = (event: MessageEvent): void => {
    if (isRenderMessage(event.data)) answer(render(event.data));
  };

  const onWindowMessage = (event: MessageEvent): void => {
    const data = event.data as { drawio?: unknown; kind?: unknown } | null;
    const given = event.ports?.[0];

    if (port !== undefined || given === undefined) return;
    if (data?.drawio !== DIAGRAM_FRAME_PROTOCOL || data.kind !== 'connect') {
      return;
    }

    port = given;
    port.onmessage = onPortMessage;
    answer({ type: 'ready', version: DIAGRAM_FRAME_PROTOCOL });
  };

  try {
    win.addEventListener('message', onWindowMessage);
    win.parent.postMessage(
      { drawio: DIAGRAM_FRAME_PROTOCOL, kind: 'hello' },
      '*',
    );
  } catch {
    // A frame without a parent is never connected; it has nothing to do.
  }
};

/** An `error` answer, its message cut to FRAME_ERROR_LIMIT characters. */
const failure = (message: string): FrameMessage => ({
  type: 'error',
  message: message.slice(0, FRAME_ERROR_LIMIT),
});

const isRenderMessage = (data: unknown): data is RenderMessage => {
  const message = data as Partial<RenderMessage> | null;

  return (
    typeof message === 'object' &&
    message !== null &&
    message.type === 'render' &&
    message.version === DIAGRAM_FRAME_PROTOCOL &&
    typeof message.svg === 'string' &&
    (message.theme === 'light' || message.theme === 'dark')
  );
};
