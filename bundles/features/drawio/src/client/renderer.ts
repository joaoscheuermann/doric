// The hidden draw.io editor that draws a diagram page as SVG (spec
// "Renderizador"): one per window, module state, a serial queue. Each request
// is one `export` of an `mxfile` holding only the page asked for (D22): the
// editor's SVG export ignores `pageId`, so the renderer never passes it.

import { DrawioClient, DrawioError } from '@drawio/react';
import { DRAWIO_ORIGIN } from 'bundle/contracts';

import { type DiagramTheme, RENDER_TIMEOUT_MS } from '../contracts/index.js';
import { RenderError, singlePageOf } from './single-page.js';

export {
  RenderError,
  type RenderErrorCode,
  singlePageOf,
} from './single-page.js';

/** One drawing the renderer is asked for. */
export interface RenderRequest {
  /** The normalized `mxfile`, as the revision holds it, with every page. */
  readonly xml: string;
  /** The page's `<diagram id>`; absent, the first page. */
  readonly pageId?: string;
  readonly theme: DiagramTheme;
  /** `svg`: an image with `data-cell-id`; `xmlsvg`: an image with the diagram inside. */
  readonly format: 'svg' | 'xmlsvg';
}

/**
 * The editor URL for `theme`:
 * `${DRAWIO_ORIGIN}/index.html?embed=1&proto=json&configure=1&stealth=1&lockdown=1&pwa=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&spin=0&dark=<0|1>`,
 * the parameters in that order, `dark=1` exactly for `'dark'`. Pure.
 */
export const rendererUrl: (theme: DiagramTheme) => string = (theme) =>
  `${DRAWIO_ORIGIN}/index.html?embed=1&proto=json&configure=1&stealth=1&lockdown=1&pwa=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&spin=0&dark=${theme === 'dark' ? 1 : 0}`;

/** The one export request the renderer sends: a whole single-page `mxfile`, no `pageId`. */
export interface RendererExportRequest {
  readonly xml: string;
  readonly format: 'svg' | 'xmlsvg';
  readonly keepTheme: false;
  readonly embedImages: true;
  readonly embedFonts: false;
}

/** What the renderer passes to the client it creates; never `onInit`. */
export interface RendererClientOptions {
  /** `rendererUrl(theme)`. */
  readonly url: string;
  readonly config: { readonly compressXml: false };
  /** The renderer's `timeoutMs`. */
  readonly requestTimeout: number;
}

/**
 * What the renderer uses of `@drawio/react`'s `DrawioClient`; a `DrawioClient`
 * satisfies it. `export` resolves with the editor's `export` event, whose
 * `data` is a data URI; it rejects with a `DrawioError` (or anything else).
 */
export interface RendererClient {
  export(request: RendererExportRequest): Promise<{ readonly data?: unknown }>;
  close(): void;
}

export interface RendererOptions {
  /** Where the iframe goes (`document.body`). Default: the global `document`. */
  readonly document?: Document;
  /**
   * Creates the client over the iframe the renderer just appended; the
   * client sets the iframe's `src`. Default: `new DrawioClient(iframe, options)`.
   */
  readonly createClient?: (
    iframe: HTMLIFrameElement,
    options: RendererClientOptions,
  ) => RendererClient;
  /** Per-request timeout, ms. Default: `RENDER_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** After this long without a request, the client is closed and the iframe removed. Default: 60 000 ms. */
  readonly idleMs?: number;
}

/** One hidden editor iframe and a serial queue of requests. */
export interface Renderer {
  /**
   * Resolves with the SVG text of page `request.pageId` (absent: the first)
   * drawn in `request.theme`. Rejects with `RenderError`: `invalid-xml` when
   * `singlePageOf` throws or the editor refuses the XML (`DrawioError`
   * `editor` or `invalid`), `unavailable` for any other failure.
   */
  render(request: RenderRequest): Promise<string>;
  /**
   * Closes the client and removes the iframe. Pending and queued requests,
   * and every later `render`, reject with `RenderError('unavailable')`.
   * Idempotent.
   */
  dispose(): void;
}

/**
 * A renderer. Nothing is created until the first request; then the
 * renderer appends to `document.body` one iframe with `aria-hidden="true"`,
 * `tabindex="-1"`, `sandbox="allow-scripts allow-same-origin"`, offscreen
 * and `visibility: hidden` (never `display: none`), and creates one client
 * over it with `{ url: rendererUrl(theme), config: { compressXml: false },
 * requestTimeout: timeoutMs }`.
 *
 * What stays true:
 * - Requests run one at a time, in call order; a request starts only after
 *   the previous one settled.
 * - A request whose theme differs from the live client's closes that client,
 *   removes its iframe and creates a new pair for the new theme.
 * - Each request is exactly one `export({ xml: singlePageOf(xml, pageId),
 *   format, keepTheme: false, embedImages: true, embedFonts: false })`; the
 *   request object never has a `pageId` key.
 * - The answer is the SVG text decoded from the event's `data` URI, base64
 *   or URI-encoded; a `data` that is not such a URI is `unavailable`.
 * - `invalid-xml` keeps the client and iframe. `unavailable` (`DrawioError`
 *   `timeout`, `restarted`, `closed`, or any other failure) closes the
 *   client and removes the iframe; the next request creates a new pair.
 * - After `idleMs` without a request, the client is closed and the iframe
 *   removed; the next request creates a new pair.
 */
export const createRenderer: (options?: RendererOptions) => Renderer = (
  options = {},
) => {
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
  const idleMs = options.idleMs ?? 60_000;
  const createClient =
    options.createClient ??
    ((iframe, clientOptions) => new DrawioClient(iframe, clientOptions));
  let live: Editor | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let abort: (error: RenderError) => void = () => undefined;
  const disposal = new Promise<never>((_, reject) => {
    abort = reject;
  });

  disposal.catch(() => undefined);

  const drop = (): void => {
    live?.client.close();
    live?.iframe.remove();
    live = undefined;
  };

  const open = (theme: DiagramTheme): Editor => {
    const doc = options.document ?? document;
    const iframe = doc.createElement('iframe');

    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.style.position = 'fixed';
    iframe.style.left = '-10000px';
    iframe.style.top = '0';
    iframe.style.width = '1024px';
    iframe.style.height = '768px';
    iframe.style.border = '0';
    iframe.style.visibility = 'hidden';
    doc.body.append(iframe);

    const client = createClient(iframe, {
      url: rendererUrl(theme),
      config: { compressXml: false },
      requestTimeout: timeoutMs,
    });

    return { theme, iframe, client };
  };

  const run = async (request: RenderRequest): Promise<string> => {
    if (disposed) throw unavailable('The renderer was disposed.');
    clearTimeout(idle);

    try {
      const xml = singlePageOf(request.xml, request.pageId);

      if (live !== undefined && live.theme !== request.theme) drop();
      live ??= open(request.theme);

      const { client } = live;

      try {
        const answer = await Promise.race([
          client.export({
            xml,
            format: request.format,
            keepTheme: false,
            embedImages: true,
            embedFonts: false,
          }),
          disposal,
        ]);

        return svgOfDataUri(answer.data);
      } catch (error) {
        const refused =
          error instanceof DrawioError &&
          (error.code === 'editor' || error.code === 'invalid');

        if (refused) {
          throw new RenderError('invalid-xml', error.message, { cause: error });
        }
        if (live?.client === client) drop();
        throw error instanceof RenderError
          ? error
          : new RenderError('unavailable', messageOf(error), { cause: error });
      }
    } finally {
      if (!disposed && live !== undefined) {
        idle = setTimeout(drop, idleMs);
      }
    }
  };

  return {
    render: (request) => {
      const next = queue.then(() => run(request));

      queue = next.catch(() => undefined);

      return next;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(idle);
      drop();
      abort(unavailable('The renderer was disposed.'));
    },
  };
};

/** The live editor: its theme, its iframe and its client. */
interface Editor {
  readonly theme: DiagramTheme;
  readonly iframe: HTMLIFrameElement;
  readonly client: RendererClient;
}

const unavailable = (message: string): RenderError =>
  new RenderError('unavailable', message);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The text of a base64 or URI-encoded `data:` URI; anything else is `unavailable`. */
const svgOfDataUri = (data: unknown): string => {
  const match =
    typeof data === 'string' ? /^data:([^,]*),(.*)$/su.exec(data) : null;

  if (match === null) {
    throw unavailable('The editor answered without a data URI.');
  }

  const [, meta = '', payload = ''] = match;

  try {
    if (!meta.endsWith(';base64')) return decodeURIComponent(payload);

    const binary = atob(payload);

    return new TextDecoder().decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch (error) {
    throw new RenderError(
      'unavailable',
      'The editor answered a bad data URI.',
      {
        cause: error,
      },
    );
  }
};

/**
 * Renders through the window's renderer (created with the defaults on first
 * use, never disposed). Same answers and rejections as `Renderer.render`.
 */
export const renderDiagram: (request: RenderRequest) => Promise<string> = (
  request,
) => {
  windowRenderer ??= createRenderer();

  return windowRenderer.render(request);
};

let windowRenderer: Renderer | undefined;
