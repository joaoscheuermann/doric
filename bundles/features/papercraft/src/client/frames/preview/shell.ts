// The frame shell (D6): what both frame entries do apart from drawing — the
// handshake (`hello`, `connect`, `ready` with the entry's protocol), `send`,
// error reporting, the theme, the cursor lock, the hidden set, size, measure
// and scene posting, and the shared app messages `theme`, `capture`, `hidden`,
// `cursor`, `measure` and `dispose`. `frames/openui/runtime.ts` runs it with
// protocol 2; `frames/preview/runtime.ts` keeps its own copy of these steps
// under protocol 1.

import type {
  FrameMessage,
  FrameProtocol,
  InputCapture,
  PreviewTheme,
  ProgramFrameMessage,
} from '../../frame-protocol.js';
import { type FrameInput, watchInput } from './input.js';
import type { FrameWindow } from './runtime.js';
import { deriveScene, type FrameScene } from './scene.js';
import { installMemoryStorage } from './storage.js';

export type { FrameWindow };

export interface FrameShellOptions {
  /** The entry's protocol: its `hello`, `ready` and accepted `connect` carry it. */
  readonly protocol: FrameProtocol;
  /** Each app message the shell does not handle itself (`init`, and `program` under protocol 2). */
  readonly onMessage: (message: unknown) => void;
  /** The element whose content the scene and size are measured from, once there is one. */
  readonly root: () => HTMLElement | undefined;
  /** Called once, on the app's `dispose`, after the shell stops posting. */
  readonly onDispose: () => void;
}

export interface FrameShell {
  /** Posts one message to the app on the connected port; before `connect`, nothing. */
  send(message: FrameMessage | ProgramFrameMessage): void;
  /** Posts an `error` message for `error`, its text prefixed when `prefix` is given; never throws. */
  reportError(error: unknown, prefix?: string): void;
  /** Measures again and posts `scene` and `size` when either changed; `force` posts both anyway. */
  schedule(force?: boolean): void;
  /** The theme the app last sent; `light` before the first. */
  theme(): PreviewTheme;
}

const ERROR_MESSAGE_LIMIT = 4096;
const ERROR_STACK_LIMIT = 16_384;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isTheme = (value: unknown): value is PreviewTheme =>
  value === 'light' || value === 'dark';

const isCapture = (value: unknown): value is InputCapture =>
  value === 'none' || value === 'first' || value === 'all';

const errorText = (error: unknown): string => {
  if (isRecord(error) && typeof error.message === 'string')
    return error.message;

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

/** A CSS cursor keyword the app may lock the frame's cursor to. */
const cursorKeyword = (value: unknown): string =>
  typeof value === 'string' && /^[a-z-]{1,32}$/.test(value) ? value : 'default';

/**
 * Starts the shell on the frame's window: posts `hello` with
 * `options.protocol` to the parent, takes only a `connect` of the same
 * protocol, answers `ready`, and from then on speaks only through the port.
 * Returns at once; it does not throw.
 */
export const startFrameShell = (
  win: FrameWindow,
  options: FrameShellOptions,
): FrameShell => {
  const document = win.document;
  const html = document.documentElement;

  installMemoryStorage(win);

  let port: MessagePort | undefined;
  let disposed = false;
  let theme: PreviewTheme = 'light';
  let scene: FrameScene | undefined;
  let sentScene: string | undefined;
  let sentSize: string | undefined;
  let hidden: ReadonlySet<string> = new Set();
  let layered = false;
  let input: FrameInput | undefined;
  let cursorSheet: HTMLStyleElement | undefined;
  const cleanups: (() => void)[] = [];

  const send = (message: FrameMessage | ProgramFrameMessage): void => {
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

    // A ResizeObserver loop is a notice, never the preview failing.
    if (
      (failure.error === undefined || failure.error === null) &&
      /^ResizeObserver loop/.test(String(failure.message ?? ''))
    )
      return;

    if (failure.error !== undefined && failure.error !== null)
      reportError(failure.error);
    else send(errorMessage(String(failure.message ?? 'Script error.')));
  };
  const onRejection = (event: Event): void => {
    reportError((event as PromiseRejectionEvent).reason);
  };

  win.addEventListener('error', onWindowError);
  win.addEventListener('unhandledrejection', onRejection);

  // A module's `mount` writes its render errors to the console under its
  // module's URL instead of letting them reach the window.
  const console = win.console;
  const consoleError = console.error;

  console.error = function (this: unknown, ...args: unknown[]) {
    const [first, error] = args;

    if (typeof first === 'string' && first.startsWith('papercraft: ')) {
      send(
        errorMessage(
          error === undefined ? first : `${first}: ${errorText(error)}`,
          stackOf(error),
        ),
      );
    }

    return consoleError.apply(this ?? console, args);
  };

  /* Theme, cursor and hidden layers ------------------------------------------ */

  const applyTheme = (next: PreviewTheme): void => {
    theme = next;
    html.classList.toggle('dark', next === 'dark');
    // The scheme the app gives the iframe: when the two differ, Chromium
    // paints the frame's canvas opaque.
    html.style.colorScheme = next;
  };

  const lockCursor = (locked: boolean, cursor: unknown): void => {
    if (!locked) {
      cursorSheet?.remove();
      cursorSheet = undefined;

      return;
    }

    cursorSheet ??= document.createElement('style');
    cursorSheet.textContent = [
      `html { cursor: ${cursorKeyword(cursor)} !important; }`,
      '* { cursor: inherit !important; }',
    ].join('\n');
    document.head.append(cursorSheet);
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

  /* Scene and size ----------------------------------------------------------- */

  /** The root's tree, then what the content portaled into the body. */
  const topsOf = (root: HTMLElement): Element[] => [
    ...root.children,
    ...[...document.body.children].filter((child) => child !== root),
  ];

  const measureNow = (force: boolean): void => {
    const root = options.root();

    if (disposed || root === undefined) return;

    scene = deriveScene(topsOf(root), options.protocol);
    applyHidden();

    const nodes = scene.nodes.map((node) => node.data);
    const serialized = JSON.stringify(nodes);

    if (force || serialized !== sentScene) {
      sentScene = serialized;
      send({ kind: 'scene', nodes } as FrameMessage);
    }

    const height = html.getBoundingClientRect().height;
    const width = Math.max(html.scrollWidth, html.clientWidth);
    const size = {
      width: Math.max(0, Math.ceil(Number.isFinite(width) ? width : 0)),
      height: Math.max(0, Math.ceil(Number.isFinite(height) ? height : 0)),
    };
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

  const observer = new win.MutationObserver(() => schedule());

  // Attributes are left out: the shell writes its own (hidden layers).
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

  /* The channel --------------------------------------------------------------- */

  const dispose = (): void => {
    if (disposed) return;

    disposed = true;
    input?.stop();
    for (const cleanup of cleanups.splice(0)) cleanup();
    win.removeEventListener('error', onWindowError);
    win.removeEventListener('unhandledrejection', onRejection);
    console.error = consoleError;
    scene = undefined;
    options.onDispose();
    document.body.replaceChildren();
    port?.close();
  };

  const onAppMessage = (data: unknown): void => {
    if (disposed || !isRecord(data)) return;

    switch (data.kind) {
      case 'init':
        if (isTheme(data.theme)) applyTheme(data.theme);
        if (isCapture(data.capture)) input?.setCapture(data.capture);
        options.onMessage(data);

        return;
      case 'theme':
        if (!isTheme(data.theme) || data.theme === theme) return;
        applyTheme(data.theme);
        options.onMessage(data);
        schedule(true);

        return;
      case 'capture':
        if (isCapture(data.capture)) input?.setCapture(data.capture);

        return;
      case 'hidden':
        if (
          Array.isArray(data.ids) &&
          data.ids.every((id) => typeof id === 'string')
        ) {
          hidden = new Set(data.ids as string[]);
          applyHidden();
        }

        return;
      case 'cursor':
        if (typeof data.locked === 'boolean')
          lockCursor(data.locked, data.cursor);

        return;
      case 'measure':
        schedule(true);

        return;
      case 'dispose':
        dispose();

        return;
      default:
        options.onMessage(data);
    }
  };

  const onConnect = (event: Event): void => {
    const message = event as MessageEvent;

    if (win.parent !== win && message.source !== win.parent) return;
    if (
      !isRecord(message.data) ||
      message.data.papercraft !== options.protocol ||
      message.data.kind !== 'connect'
    )
      return;

    const channel = message.ports?.[0];

    if (channel === undefined) return;

    win.removeEventListener('message', onConnect);
    port = channel;
    channel.onmessage = (incoming: MessageEvent) => onAppMessage(incoming.data);
    input = watchInput({
      win,
      report: send as (message: FrameMessage) => void,
      scene: () => scene,
    });
    send({ kind: 'ready', protocol: options.protocol } as FrameMessage);
  };

  win.addEventListener('message', onConnect);
  // Listening now: the app hands the port only once it hears this.
  if (win.parent !== win) {
    win.parent.postMessage(
      { papercraft: options.protocol, kind: 'hello' },
      '*',
    );
  }

  return { send, reportError, schedule, theme: () => theme };
};
