// The preview frame's runtime (docs/architecture/bundles/papercraft/
// isolamento.md, "O runtime do preview"): the frame side of
// `frame-protocol.ts`, running in a sandboxed iframe of opaque origin.
//
// - The handshake: the first window message `{ papercraft: PROTOCOL, kind:
//   'connect' }` that carries a port (from the parent window, when there is
//   one) is the channel; the runtime answers `ready` on it and from then on
//   reads and writes only that port. App messages it does not understand are
//   dropped.
// - `init` renders the revision once: a module is mounted on a `#root` in the
//   body, with its sheet linked first, the theme on `<html>` and in-memory
//   storage already installed; a module that does not load or mount gives
//   way to the fallback markup, else to an `error`. Markup (path A) is
//   rendered into the document itself, its `<style>`s in the head and its
//   body's attributes and content on the body, with no script run. Then
//   `mounted` states the mode and Storybook's layout.
// - The scene and the content size follow the document: after the mount, on
//   DOM changes (coalesced into one report per task), on resizes of the
//   viewport and the content, on font and sheet loads, and on `measure`.
// - `theme` switches `<html>` and mounts the module again, since a revision
//   reads its theme once per mount; `hidden`, `cursor` and `capture` apply
//   view state; `dispose` unmounts the revision and empties the document.
// - Errors of the preview become `error` messages: the window's `error` and
//   `unhandledrejection`, and the render errors a revision's `mount` writes
//   to the console as `papercraft: … in <module>`.

import { PROTOCOL } from '../../frame-constants.js';
import type {
  AppMessage,
  FrameContent,
  FrameMessage,
  InputCapture,
  PreviewLayout,
  PreviewTheme,
  SceneNodeData,
} from '../../frame-protocol.js';
import { type FrameInput, watchInput } from './input.js';
import { deriveScene, type FrameScene } from './scene.js';
import { installMemoryStorage } from './storage.js';

/** The contract a compiled revision module exports. */
interface RevisionModule {
  mount(
    root: HTMLElement,
    context: { readonly theme: PreviewTheme },
  ): undefined | (() => void);
}

/** The attribute a mounted module states its story's layout in. */
const LAYOUT_ATTRIBUTE = 'data-papercraft-layout';

/** The attribute the theme is stated in on `<html>`, as revisions read it. */
const THEME_ATTRIBUTE = 'data-papercraft-theme';

/** Marks the nodes the runtime put in the head, to clear them on dispose. */
const OWN_ATTRIBUTE = 'data-papercraft-frame';

/** How long a module waits for its sheet before it mounts anyway. */
const SHEET_WAIT_MS = 3000;

/**
 * A module's document: no body margin (the canvas surrounds the preview),
 * and a `centered` root that hugs its content, wrapping only at the frame's
 * width, as the surface's host did.
 */
const MODULE_SHEET = [
  'html, body { margin: 0; }',
  `#root:not([${LAYOUT_ATTRIBUTE}]), #root[${LAYOUT_ATTRIBUTE}="centered"] { width: fit-content; }`,
].join('\n');

/** The fallback markup of a module hugs its content too (`centered`). */
const FALLBACK_SHEET = 'html { width: fit-content; }';

const ERROR_MESSAGE_LIMIT = 4096;
const ERROR_STACK_LIMIT = 16_384;

const isThemeValue = (value: unknown): value is PreviewTheme =>
  value === 'light' || value === 'dark';

const isCapture = (value: unknown): value is InputCapture =>
  value === 'none' || value === 'first' || value === 'all';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

const contentOf = (value: unknown): FrameContent | undefined => {
  if (!isRecord(value)) return undefined;

  if (value.kind === 'markup' && typeof value.markup === 'string') {
    return { kind: 'markup', markup: value.markup };
  }

  if (
    value.kind === 'module' &&
    typeof value.module === 'string' &&
    optionalString(value.styles) &&
    optionalString(value.fallback)
  ) {
    return {
      kind: 'module',
      module: value.module,
      ...(value.styles === undefined ? {} : { styles: value.styles }),
      ...(value.fallback === undefined ? {} : { fallback: value.fallback }),
    };
  }

  return undefined;
};

/** An app message the runtime understands, else undefined. */
const appMessageOf = (data: unknown): AppMessage | undefined => {
  if (!isRecord(data)) return undefined;

  switch (data.kind) {
    case 'init': {
      const content = contentOf(data.content);

      return content !== undefined &&
        isThemeValue(data.theme) &&
        isCapture(data.capture)
        ? { kind: 'init', content, theme: data.theme, capture: data.capture }
        : undefined;
    }
    case 'theme':
      return isThemeValue(data.theme)
        ? { kind: 'theme', theme: data.theme }
        : undefined;
    case 'capture':
      return isCapture(data.capture)
        ? { kind: 'capture', capture: data.capture }
        : undefined;
    case 'hidden':
      return Array.isArray(data.ids) &&
        data.ids.every((id) => typeof id === 'string')
        ? { kind: 'hidden', ids: data.ids as string[] }
        : undefined;
    case 'cursor':
      return typeof data.locked === 'boolean' && optionalString(data.cursor)
        ? {
            kind: 'cursor',
            locked: data.locked,
            ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
          }
        : undefined;
    case 'measure':
      return { kind: 'measure' };
    case 'dispose':
      return { kind: 'dispose' };
    default:
      return undefined;
  }
};

const isConnect = (data: unknown): boolean =>
  isRecord(data) && data.papercraft === PROTOCOL && data.kind === 'connect';

const errorText = (error: unknown): string => {
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }

  try {
    return String(error);
  } catch {
    return 'An error that cannot be printed.';
  }
};

const stackOf = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.stack === 'string' ? error.stack : undefined;

const errorMessage = (message: string, stack?: string): FrameMessage => ({
  kind: 'error',
  message: message.slice(0, ERROR_MESSAGE_LIMIT),
  ...(stack === undefined || stack === ''
    ? {}
    : { stack: stack.slice(0, ERROR_STACK_LIMIT) }),
});

/** The frame's window, with its own constructors. */
export type FrameWindow = Window & typeof globalThis;

/** A CSS cursor keyword the app may lock the frame's cursor to. */
const cursorKeyword = (value: string | undefined): string =>
  value !== undefined && /^[a-z-]{1,32}$/.test(value) ? value : 'default';

/**
 * Starts the runtime in a frame's window: storage first, then the wait for
 * the app's port.
 */
export const startPreviewFrame = (win: FrameWindow): void => {
  const document = win.document;
  const html = document.documentElement;

  installMemoryStorage(win);

  let port: MessagePort | undefined;
  let initialized = false;
  let disposed = false;
  let theme: PreviewTheme = 'light';
  let mode: 'module' | 'markup' | 'fallback' | undefined;
  let layout: PreviewLayout = 'centered';
  let root: HTMLElement | undefined;
  let unmount: (() => void) | undefined;
  let scene: FrameScene | undefined;
  let sentScene: string | undefined;
  let sentSize: string | undefined;
  let hidden: ReadonlySet<string> = new Set();
  let layered = false;
  let input: FrameInput | undefined;
  const cleanups: (() => void)[] = [];

  const send = (message: FrameMessage): void => {
    if (disposed) return;

    try {
      port?.postMessage(message);
    } catch {
      // A closed port takes nothing with it.
    }
  };

  /* Errors ----------------------------------------------------------------- */

  const reportError = (error: unknown, prefix?: string): void => {
    const text = errorText(error);

    send(
      errorMessage(
        prefix === undefined ? text : `${prefix}: ${text}`,
        stackOf(error),
      ),
    );
  };

  const onWindowError = (event: Event): void => {
    const failure = event as ErrorEvent;

    // A ResizeObserver whose callback resized what it observes defers the
    // rest to the next frame and says so as an error event: a notice, never
    // the preview failing.
    if (
      (failure.error === undefined || failure.error === null) &&
      /^ResizeObserver loop/.test(String(failure.message ?? ''))
    ) {
      return;
    }

    if (failure.error !== undefined && failure.error !== null) {
      reportError(failure.error);
    } else {
      send(errorMessage(String(failure.message ?? 'Script error.')));
    }
  };
  const onRejection = (event: Event): void => {
    reportError((event as PromiseRejectionEvent).reason);
  };

  win.addEventListener('error', onWindowError);
  win.addEventListener('unhandledrejection', onRejection);

  // A revision's `mount` writes its render errors to the console under its
  // module's URL instead of letting them reach the window.
  const console = win.console;
  const consoleError = console.error;

  console.error = function (this: unknown, ...args: unknown[]) {
    const [first, error, componentStack] = args;

    if (typeof first === 'string' && first.startsWith('papercraft: ')) {
      const stack = [
        stackOf(error),
        typeof componentStack === 'string' ? componentStack : undefined,
      ]
        .filter((part) => part !== undefined)
        .join('\n');

      send(
        errorMessage(
          error === undefined ? first : `${first}: ${errorText(error)}`,
          stack,
        ),
      );
    }

    return consoleError.apply(this ?? console, args);
  };

  /* Theme and cursor --------------------------------------------------------- */

  const applyTheme = (next: PreviewTheme): void => {
    theme = next;
    html.classList.toggle('dark', next === 'dark');
    html.setAttribute(THEME_ATTRIBUTE, next);
    // The scheme the app gives the iframe: when the two differ, Chromium
    // paints the frame's canvas opaque, white under a dark app.
    html.style.colorScheme = next;
  };

  let cursorSheet: HTMLStyleElement | undefined;

  const lockCursor = (locked: boolean, cursor: string | undefined): void => {
    if (!locked) {
      cursorSheet?.remove();
      cursorSheet = undefined;

      return;
    }

    cursorSheet ??= ownElement('style');
    cursorSheet.textContent = [
      `html { cursor: ${cursorKeyword(cursor)} !important; }`,
      '* { cursor: inherit !important; }',
    ].join('\n');
    document.head.append(cursorSheet);
  };

  const ownElement = <K extends 'style' | 'link'>(
    tag: K,
  ): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    element.setAttribute(OWN_ATTRIBUTE, '');

    return element;
  };

  /* Scene and size -------------------------------------------------------- */

  const topsOf = (): Element[] => {
    if (mode === undefined) return [];
    if (root === undefined) return [document.body];

    const current = root;

    // The root's tree (an old revision's portal container included), then
    // what the preview portaled into the body.
    return [
      ...current.children,
      ...[...document.body.children].filter((child) => child !== current),
    ];
  };

  const applyHidden = (): void => {
    if (hidden.size === 0 && !layered) return;

    for (const node of scene?.nodes ?? []) {
      (node.element as HTMLElement).style.visibility = hidden.has(node.data.id)
        ? 'hidden'
        : '';
    }

    layered = hidden.size > 0;
  };

  /**
   * The content's size. A `centered` preview reports its max-content width,
   * whatever the frame's width is now: the element that hugs the content is
   * laid out at `max-content` for the reading, then given back its width.
   */
  const sizeOf = (): { width: number; height: number } => {
    let width: number;

    if (layout === 'centered') {
      const hugging = root ?? html;
      const given = hugging.style.width;

      hugging.style.width = 'max-content';
      width = hugging.getBoundingClientRect().width;
      hugging.style.width = given;
    } else {
      width = Math.max(html.scrollWidth, html.clientWidth);
    }

    const height = html.getBoundingClientRect().height;

    return {
      width: Math.max(0, Math.ceil(Number.isFinite(width) ? width : 0)),
      height: Math.max(0, Math.ceil(Number.isFinite(height) ? height : 0)),
    };
  };

  const measureNow = (force: boolean): void => {
    if (disposed || mode === undefined) return;

    scene = deriveScene(topsOf());
    applyHidden();

    const nodes: SceneNodeData[] = scene.nodes.map((node) => node.data);
    const serialized = JSON.stringify(nodes);

    if (force || serialized !== sentScene) {
      sentScene = serialized;
      send({ kind: 'scene', nodes });
    }

    const size = sizeOf();
    const sized = JSON.stringify(size);

    if (force || sized !== sentSize) {
      sentSize = sized;
      send({ kind: 'size', ...size });
    }
  };

  let queued = false;
  let forced = false;

  /** One report per task, however many changes asked for it. */
  const schedule = (force = false): void => {
    forced ||= force;

    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;

      const now = forced;
      forced = false;
      measureNow(now);
    });
  };

  const watchDocument = (): void => {
    const observer = new win.MutationObserver(() => schedule());

    // Attributes are left out: the runtime writes its own (hidden layers).
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    cleanups.push(() => observer.disconnect());

    const onResize = (): void => schedule(true);

    win.addEventListener('resize', onResize);
    cleanups.push(() => win.removeEventListener('resize', onResize));

    if (typeof win.ResizeObserver === 'function') {
      const resized = new win.ResizeObserver(() => schedule());

      resized.observe(html);
      resized.observe(document.body);
      cleanups.push(() => resized.disconnect());
    }

    const fonts = (document as { fonts?: EventTarget }).fonts;

    if (fonts !== undefined && typeof fonts.addEventListener === 'function') {
      const onFonts = (): void => schedule();

      fonts.addEventListener('loadingdone', onFonts);
      cleanups.push(() => fonts.removeEventListener('loadingdone', onFonts));
    }
  };

  /* Rendering --------------------------------------------------------------- */

  const renderMarkup = (markup: string): void => {
    const parsed = new win.DOMParser().parseFromString(markup, 'text/html');
    const body = document.body;

    // The document's `<style>`s, and the body's own attributes (its origin
    // stamp, a class the styles key on) and content. `innerHTML` runs no
    // script, and none is kept.
    for (const style of parsed.head.querySelectorAll('style')) {
      const own = ownElement('style');
      own.textContent = style.textContent;
      document.head.append(own);
    }

    for (const attribute of [...parsed.body.attributes]) {
      body.setAttribute(attribute.name, attribute.value);
    }

    body.innerHTML = parsed.body.innerHTML;

    for (const script of body.querySelectorAll('script')) script.remove();
  };

  const linkSheet = (href: string): Promise<void> => {
    const link = ownElement('link');
    link.rel = 'stylesheet';
    link.href = href;

    const settled = new Promise<void>((resolve) => {
      const done = (): void => {
        resolve();
        schedule();
      };

      link.addEventListener('load', done, { once: true });
      link.addEventListener('error', done, { once: true });
      win.setTimeout(resolve, SHEET_WAIT_MS);
    });

    document.head.append(link);

    return settled;
  };

  const newRoot = (): HTMLElement => {
    const element = document.createElement('div');
    element.id = 'root';
    document.body.append(element);

    return element;
  };

  const layoutOfRoot = (element: HTMLElement): PreviewLayout => {
    const stated = element.getAttribute(LAYOUT_ATTRIBUTE);

    return stated === 'padded' || stated === 'fullscreen' ? stated : 'centered';
  };

  const releaseModule = (): void => {
    const release = unmount;
    unmount = undefined;

    try {
      release?.();
    } catch (error) {
      reportError(error, 'papercraft: the revision failed to unmount');
    }
  };

  /** Mounts the module on a fresh `#root`; throws when it cannot. */
  const mountModule = (loaded: unknown): void => {
    const module = loaded as Partial<RevisionModule> | undefined;

    if (typeof module?.mount !== 'function') {
      throw new TypeError('The revision module exports no mount.');
    }

    const element = newRoot();
    root = element;

    try {
      const result = module.mount(element, { theme });

      unmount =
        typeof result === 'function' ? result : () => element.replaceChildren();
    } catch (error) {
      element.remove();
      root = undefined;
      throw error;
    }

    layout = layoutOfRoot(element);
  };

  let loadedModule: unknown;

  const mounted = (next: 'module' | 'markup' | 'fallback'): void => {
    mode = next;
    send({ kind: 'mounted', mode: next, layout });
    schedule(true);
  };

  const init = async (
    message: Extract<AppMessage, { kind: 'init' }>,
  ): Promise<void> => {
    const content = message.content;
    applyTheme(message.theme);
    input?.setCapture(message.capture);
    watchDocument();

    if (content.kind === 'markup') {
      layout = 'fullscreen';
      renderMarkup(content.markup);
      mounted('markup');

      return;
    }

    const moduleSheet = ownElement('style');
    moduleSheet.textContent = MODULE_SHEET;
    document.head.append(moduleSheet);

    const sheet =
      content.styles === undefined ? undefined : linkSheet(content.styles);

    try {
      const [loaded] = await Promise.all([
        import(/* @vite-ignore */ content.module) as Promise<unknown>,
        sheet,
      ]);

      if (disposed) return;

      loadedModule = loaded;
      mountModule(loaded);
      mounted('module');
    } catch (error) {
      if (disposed) return;

      for (const own of document.head.querySelectorAll(`[${OWN_ATTRIBUTE}]`)) {
        if (own !== cursorSheet) own.remove();
      }

      if (content.fallback === undefined) {
        reportError(error, 'papercraft: the revision did not mount');

        return;
      }

      // A component whose module did not load hugs its markup.
      const fallbackSheet = ownElement('style');
      fallbackSheet.textContent = FALLBACK_SHEET;
      document.head.append(fallbackSheet);
      layout = 'centered';
      renderMarkup(content.fallback);
      mounted('fallback');
    }
  };

  /** A revision reads its theme once per mount: a new theme mounts it again. */
  const remount = (): void => {
    if (mode !== 'module' || root === undefined) return;

    const previous = root;

    // The old root leaves first: its unmount may finish later, on its own
    // detached tree.
    previous.remove();
    releaseModule();
    root = undefined;

    try {
      mountModule(loadedModule);
      send({ kind: 'mounted', mode: 'module', layout });
    } catch (error) {
      reportError(error, 'papercraft: the revision did not mount');
    }

    schedule(true);
  };

  const dispose = (): void => {
    if (disposed) return;

    releaseModule();
    disposed = true;
    input?.stop();

    for (const cleanup of cleanups.splice(0)) cleanup();

    win.removeEventListener('error', onWindowError);
    win.removeEventListener('unhandledrejection', onRejection);
    console.error = consoleError;

    root = undefined;
    scene = undefined;
    document.body.replaceChildren();

    for (const attribute of [...document.body.attributes]) {
      document.body.removeAttribute(attribute.name);
    }

    for (const own of document.head.querySelectorAll(`[${OWN_ATTRIBUTE}]`)) {
      own.remove();
    }

    port?.close();
  };

  /* The channel --------------------------------------------------------------- */

  const onAppMessage = (data: unknown): void => {
    if (disposed) return;

    const message = appMessageOf(data);

    if (message === undefined) return;

    switch (message.kind) {
      case 'init':
        if (initialized) return;
        initialized = true;
        void init(message);

        return;
      case 'theme':
        if (message.theme === theme) return;
        applyTheme(message.theme);
        remount();

        return;
      case 'capture':
        input?.setCapture(message.capture);

        return;
      case 'hidden':
        hidden = new Set(message.ids);
        applyHidden();

        return;
      case 'cursor':
        lockCursor(message.locked, message.cursor);

        return;
      case 'measure':
        schedule(true);

        return;
      case 'dispose':
        dispose();

        return;
    }
  };

  const onConnect = (event: Event): void => {
    const message = event as MessageEvent;

    if (win.parent !== win && message.source !== win.parent) return;
    if (!isConnect(message.data)) return;

    const channel = message.ports?.[0];

    if (channel === undefined) return;

    win.removeEventListener('message', onConnect);
    port = channel;
    channel.onmessage = (incoming: MessageEvent) => onAppMessage(incoming.data);
    input = watchInput({ win, report: send, scene: () => scene });
    send({ kind: 'ready', protocol: PROTOCOL });
  };

  win.addEventListener('message', onConnect);
  // Listening now: the app hands the port only once it hears this.
  if (win.parent !== win) {
    win.parent.postMessage({ papercraft: PROTOCOL, kind: 'hello' }, '*');
  }
};
