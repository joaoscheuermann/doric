// The measure frame, app side (spec "Frame de medida"): one hidden sandboxed
// iframe per window that measures a drawn SVG's cell boxes, and a serial
// queue of requests.

import {
  type DiagramLayout,
  type DiagramTheme,
  RENDER_TIMEOUT_MS,
} from '../contracts/index.js';
import {
  DIAGRAM_FRAME_PROTOCOL,
  type FrameConnect,
  frameDocumentUrl,
  isFrameHello,
  parseFrameMessage,
  type RenderMessage,
} from './frame-protocol.js';
import { RenderError } from './single-page.js';

/**
 * The `src` of the measure frame:
 * `frameDocumentUrl(new URL('./frames/diagram.js', import.meta.url).href)`,
 * i.e. `doric://app/frame/index.html?entry=…%2Fclient%2Fframes%2Fdiagram.js`
 * for the running bundle version. Pure.
 */
export const diagramFrameSrc: () => string = () =>
  frameDocumentUrl(new URL('./frames/diagram.js', import.meta.url).href);

export interface MeasureOptions {
  /** Where the iframe goes (`document.body`). Default: the global `document`. */
  readonly document?: Document;
  /** The iframe's `src`. Default: `diagramFrameSrc()`. */
  readonly frameSrc?: string;
  /** Per-measure timeout, ms, including the wait for `hello` and `ready`. Default: `RENDER_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Where an off-schema frame message is reported. Default: `console.warn`. */
  readonly log?: (message: string) => void;
}

/** One hidden measure frame and a serial queue of measures. */
export interface Measurer {
  /**
   * Resolves with the layout of `svg` shown in `theme`: the `rendered`
   * message's `width`, `height` and `cells`. Rejects with
   * `RenderError('unavailable')` on a timeout, an off-schema frame message
   * or an `error` message.
   */
  measure(svg: string, theme: DiagramTheme): Promise<DiagramLayout>;
  /**
   * Removes the frame. Pending and queued measures, and every later
   * `measure`, reject with `RenderError('unavailable')`. Idempotent.
   */
  dispose(): void;
}

/**
 * A measurer. Nothing is created until the first measure; then it appends to
 * `document.body` one `<iframe sandbox="allow-scripts">` (exactly that
 * token) with `aria-hidden="true"`, `tabindex="-1"`, offscreen and
 * `visibility: hidden`, `src` = `frameSrc`.
 *
 * What stays true:
 * - A `hello` (`isFrameHello`) is taken only from that iframe's
 *   `contentWindow`; it is answered with one `connect` carrying a new
 *   channel's port. Window messages from any other source are ignored.
 * - Only messages on that port are read, each through `parseFrameMessage`.
 * - Measures run one at a time, in call order; each posts exactly one
 *   `{ type: 'render', version: 1, svg, theme }` after `ready`.
 * - A timeout, an off-schema message (passed to `log`) or an `error`
 *   message rejects the current measure with `RenderError('unavailable')`
 *   and removes the frame; the next measure creates a new one.
 */
export const createMeasurer: (options?: MeasureOptions) => Measurer = (
  options = {},
) => {
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
  const log = options.log ?? ((message: string) => console.warn(message));
  let frame: Frame | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;

  const drop = (): void => {
    frame?.close();
    frame = undefined;
  };

  const run = async (
    svg: string,
    theme: DiagramTheme,
  ): Promise<DiagramLayout> => {
    if (disposed) throw unavailable('The measure frame was disposed.');

    frame ??= openFrame(options.document ?? document, options.frameSrc);

    const current = frame;

    try {
      return await current.measure(
        { type: 'render', version: DIAGRAM_FRAME_PROTOCOL, svg, theme },
        timeoutMs,
        log,
      );
    } catch (error) {
      if (frame === current) drop();
      throw error;
    }
  };

  return {
    measure: (svg, theme) => {
      const next = queue.then(() => run(svg, theme));

      queue = next.catch(() => undefined);

      return next;
    },
    dispose: () => {
      disposed = true;
      drop();
    },
  };
};

const unavailable = (message: string): RenderError =>
  new RenderError('unavailable', message);

/** One inserted measure frame: its handshake, its port and its one pending measure. */
interface Frame {
  measure(
    message: RenderMessage,
    timeoutMs: number,
    log: (message: string) => void,
  ): Promise<DiagramLayout>;
  close(): void;
}

/** The measure under way: how it ends. */
interface Pending {
  readonly message: RenderMessage;
  readonly log: (message: string) => void;
  readonly resolve: (layout: DiagramLayout) => void;
  readonly reject: (error: RenderError) => void;
}

const openFrame = (doc: Document, src = diagramFrameSrc()): Frame => {
  const view = doc.defaultView ?? window;
  const iframe = doc.createElement('iframe');
  let port: MessagePort | undefined;
  let ready = false;
  let pending: Pending | undefined;
  let closed = false;

  const post = (): void => {
    if (ready && pending !== undefined) port?.postMessage(pending.message);
  };

  const onPortMessage = (event: MessageEvent): void => {
    const parsed = parseFrameMessage(event.data);
    const current = pending;

    if (parsed?.type === 'ready' && !ready) {
      ready = true;
      post();
      return;
    }
    if (current === undefined) return;
    pending = undefined;
    if (parsed?.type === 'rendered' && ready) {
      current.resolve({
        width: parsed.width,
        height: parsed.height,
        cells: parsed.cells,
      });
    } else if (parsed?.type === 'error') {
      current.reject(
        unavailable(`The measure frame failed: ${parsed.message}`),
      );
    } else {
      const message = `The measure frame sent an unexpected message: ${describe(event.data)}`;

      current.log(message);
      current.reject(unavailable(message));
    }
  };

  const onHello = (event: MessageEvent): void => {
    if (port !== undefined || event.source !== iframe.contentWindow) return;
    if (!isFrameHello(event.data)) return;

    const channel = new MessageChannel();
    const connect: FrameConnect = {
      drawio: DIAGRAM_FRAME_PROTOCOL,
      kind: 'connect',
    };

    port = channel.port1;
    port.onmessage = onPortMessage;
    iframe.contentWindow?.postMessage(connect, '*', [channel.port2]);
  };

  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  hideOffscreen(iframe);
  iframe.setAttribute('src', src);
  view.addEventListener('message', onHello);
  doc.body.append(iframe);

  return {
    measure: (message, timeoutMs, log) =>
      new Promise<DiagramLayout>((resolve, reject) => {
        if (closed) {
          reject(unavailable('The measure frame was closed.'));
          return;
        }

        const timer = setTimeout(() => {
          pending = undefined;
          reject(unavailable('The measure frame did not answer in time.'));
        }, timeoutMs);
        const done =
          <T>(settle: (value: T) => void) =>
          (value: T): void => {
            clearTimeout(timer);
            settle(value);
          };

        pending = {
          message,
          log,
          resolve: done(resolve),
          reject: done(reject),
        };
        post();
      }),
    close: () => {
      if (closed) return;
      closed = true;
      view.removeEventListener('message', onHello);
      port?.close();
      iframe.remove();
      pending?.reject(unavailable('The measure frame was closed.'));
      pending = undefined;
    },
  };
};

/** Offscreen and invisible, but laid out (never `display: none`). */
const hideOffscreen = (iframe: HTMLIFrameElement): void => {
  iframe.style.position = 'fixed';
  iframe.style.left = '-10000px';
  iframe.style.top = '0';
  iframe.style.width = '1024px';
  iframe.style.height = '768px';
  iframe.style.border = '0';
  iframe.style.visibility = 'hidden';
};

/** A short, safe description of an off-schema message for the log. */
const describe = (data: unknown): string => {
  try {
    return (JSON.stringify(data) ?? String(data)).slice(0, 200);
  } catch {
    return typeof data;
  }
};

/**
 * Measures through the window's measurer (created with the defaults on first
 * use, never disposed). Same answers and rejections as `Measurer.measure`.
 */
export const measureDiagram: (
  svg: string,
  theme: DiagramTheme,
) => Promise<DiagramLayout> = (svg, theme) => {
  windowMeasurer ??= createMeasurer();

  return windowMeasurer.measure(svg, theme);
};

let windowMeasurer: Measurer | undefined;
