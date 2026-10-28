// A fake preview frame: a test double of the preview runtime
// (`src/client/frames/preview.ts`) at its only boundary with the app, the
// frame protocol (`src/client/frame-protocol.ts`).
//
// happy-dom loads no frame document, so the fake attaches itself to every
// preview iframe the app inserts: it stands in for the iframe's
// `contentWindow` (receiving the `connect` window message and its port, as a
// real frame does), dispatches the iframe's `load`, and from then on speaks
// the protocol over the real `MessageChannel` the app opened. By default it
// behaves as the runtime does — `ready` on connect; on `init`, the content
// rendered (a markup, or a module the test describes) and `mounted`, `size`
// and `scene` sent; a fresh `scene` on `measure` — and every test can also
// post anything, valid or not, on the channel or elsewhere.
//
// The scene is derived from the markup the fake renders, parsed by
// happy-dom: nodes in document order, each with its tag, `id`, classes, own
// stamp and text; happy-dom lays nothing out, so every box is empty unless
// the test lays an element out by selector.

import type {
  AppMessage,
  FrameContent,
  PreviewLayout,
  SceneNodeData,
} from '../../../src/client/frame-protocol.js';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The boxes of an element, by selector: its own and its pseudo-elements'. */
export interface Placed {
  readonly box?: Box;
  readonly before?: Box;
  readonly after?: Box;
}

/** What a module does when the fake frame loads it. */
export type ModuleBehaviour =
  | { readonly mounts: string; readonly layout?: PreviewLayout }
  | { readonly fails: true };

export interface FakeOptions {
  /** Answers the handshake and `init` as the runtime does (default true). */
  readonly auto?: boolean;
  /** The module behind a module URL; a module fails to load by default. */
  readonly module?: (url: string) => ModuleBehaviour;
  /** The layout of the rendered elements, by selector. */
  readonly layout?: Readonly<Record<string, Placed>>;
  /** The content size the frame reports. */
  readonly size?: { readonly width: number; readonly height: number };
}

type InitMessage = Extract<AppMessage, { kind: 'init' }>;

interface Modifiers {
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

export interface FakeFrame {
  readonly iframe: HTMLIFrameElement;
  /** Every message the app posted on the channel, in order. */
  readonly received: readonly AppMessage[];
  /** The app's `init`, once it came. */
  readonly init: InitMessage | undefined;
  /** Whether the app handed the frame its port. */
  readonly connected: boolean;
  /** Whether the frame sent its first scene. */
  readonly rendered: boolean;
  /** Whether the app's port closed. */
  readonly closed: boolean;
  /** Posts anything on the channel, as the frame's code could. */
  post(data: unknown): void;
  /** Answers the handshake. */
  ready(): void;
  /** Renders a markup as the given mode, then reports it. */
  render(markup: string, mode: 'module' | 'markup' | 'fallback'): void;
  /** Sends the scene of what is rendered now. */
  sendScene(): void;
  /** The scene node id of the element a selector names. */
  nodeId(selector: string): string;
  /** A pointer report over the element `on` names (none: empty space). */
  pointer(
    type: 'move' | 'down' | 'up' | 'click' | 'leave',
    on: string | undefined,
    init?: Modifiers & {
      readonly x?: number;
      readonly y?: number;
      readonly pseudo?: '::before' | '::after';
    },
  ): void;
  wheel(
    point: { readonly x: number; readonly y: number },
    delta: { readonly deltaX?: number; readonly deltaY?: number },
    modifiers?: Modifiers,
  ): void;
  key(type: 'keydown' | 'keyup', key: string, modifiers?: Modifiers): void;
  focus(focused: boolean): void;
  /** Lays elements out (and sends the scene again when rendered). */
  lay(layout: Readonly<Record<string, Placed>>): void;
  /** Closes the channel, as a frame that goes does. */
  close(): void;
}

export interface FakeFrames {
  /** Every frame attached so far, oldest first. */
  readonly all: readonly FakeFrame[];
  /** The newest frame whose iframe is still in the document under `root`. */
  latest(root?: Node): FakeFrame | undefined;
  /** Waits for the newest frame under `root` that satisfies `holds`. */
  next(root?: Node, holds?: (frame: FakeFrame) => boolean): Promise<FakeFrame>;
  /** Detaches from the document and closes every channel. */
  dispose(): void;
}

const SKIPPED = new Set(['STYLE', 'LINK', 'SCRIPT', 'META', 'TITLE', 'HEAD']);
const EMPTY: Box = { x: 0, y: 0, width: 0, height: 0 };

const modifiersOf = (init: Modifiers = {}) => ({
  altKey: init.altKey ?? false,
  ctrlKey: init.ctrlKey ?? false,
  metaKey: init.metaKey ?? false,
  shiftKey: init.shiftKey ?? false,
});

/** Waits for the channel's messages to be delivered. */
export const delivered = async (): Promise<void> => {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((done) => setTimeout(done, 0));
  }
};

/**
 * The scene nodes a frame derives from the elements under `root`, in
 * document order, as the runtime serializes them: `root` itself first when
 * `includeRoot`. Every box is empty unless `layout` places it.
 */
export const sceneNodesOf = (
  root: Element,
  options: {
    readonly includeRoot?: boolean;
    readonly layout?: Readonly<Record<string, Placed>>;
  } = {},
): { readonly nodes: SceneNodeData[]; readonly elements: Element[] } => {
  const nodes: SceneNodeData[] = [];
  const elements: Element[] = [];
  const layout = options.layout ?? {};

  const boxesOf = (element: Element): Placed => {
    let placed: Placed = {};

    for (const [selector, at] of Object.entries(layout)) {
      if (element.matches(selector)) placed = { ...placed, ...at };
    }

    return placed;
  };

  const visit = (element: Element, depth: number, parentId?: string) => {
    if (SKIPPED.has(element.tagName)) return;

    const id = `n${String(nodes.length)}`;
    const placed = boxesOf(element);
    const elementId = element.getAttribute('id');
    const stamp = element.getAttribute('data-papercraft-source');
    const pseudo = {
      ...(placed.before === undefined ? {} : { '::before': placed.before }),
      ...(placed.after === undefined ? {} : { '::after': placed.after }),
    };

    elements.push(element);
    nodes.push({
      id,
      ...(parentId === undefined ? {} : { parentId }),
      depth,
      tag: element.tagName.toLowerCase(),
      classes: (element.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter((name) => name !== ''),
      ...(elementId === null || elementId === '' ? {} : { elementId }),
      ...(stamp === null || stamp === '' ? {} : { stamp }),
      text: (element.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120),
      bounds: placed.box ?? EMPTY,
      ...(Object.keys(pseudo).length === 0 ? {} : { pseudo }),
    });

    for (const child of element.children) visit(child, depth + 1, id);
  };

  if (options.includeRoot === true) visit(root, 0);
  else for (const child of root.children) visit(child, 0);

  return { nodes, elements };
};

interface HappyWindow {
  readonly document: Document;
  readonly DOMParser: typeof DOMParser;
  readonly MutationObserver: typeof MutationObserver;
  readonly Event: typeof Event;
  readonly MessageEvent: typeof MessageEvent;
  dispatchEvent(event: Event): boolean;
}

const attach = (
  window: HappyWindow,
  iframe: HTMLIFrameElement,
  options: FakeOptions,
): FakeFrame => {
  const received: AppMessage[] = [];
  const state: {
    port: MessagePort | undefined;
    init: InitMessage | undefined;
    rendered: boolean;
    closed: boolean;
    document: Document | undefined;
    elements: Element[];
    layout: Record<string, Placed>;
    bodyNode: boolean;
  } = {
    port: undefined,
    init: undefined,
    rendered: false,
    closed: false,
    document: undefined,
    elements: [],
    layout: { ...options.layout },
    bodyNode: true,
  };
  const auto = options.auto ?? true;
  let moduleLayout: PreviewLayout | undefined;

  const post = (data: unknown): void => state.port?.postMessage(data);

  const nodes = (): SceneNodeData[] => {
    const document = state.document;

    state.elements = [];
    if (document === undefined) return [];

    const derived = sceneNodesOf(document.body, {
      includeRoot: state.bodyNode,
      layout: state.layout,
    });

    state.elements = derived.elements;

    return derived.nodes;
  };

  const frame: FakeFrame = {
    iframe,
    received,
    get init() {
      return state.init;
    },
    get connected() {
      return state.port !== undefined;
    },
    get rendered() {
      return state.rendered;
    },
    get closed() {
      return state.closed;
    },
    post,
    ready: () => post({ kind: 'ready', protocol: 1 }),
    render: (markup, mode) => {
      state.document = new window.DOMParser().parseFromString(
        markup,
        'text/html',
      );
      // A page is its body; a module renders into its root.
      state.bodyNode = mode !== 'module';
      post({
        kind: 'mounted',
        mode,
        // As the runtime: a module states its layout, a page fills.
        layout: mode === 'module' ? (moduleLayout ?? 'centered') : 'fullscreen',
      });
      post({ kind: 'size', ...(options.size ?? { width: 0, height: 0 }) });
      frame.sendScene();
    },
    sendScene: () => {
      post({ kind: 'scene', nodes: nodes() });
      state.rendered = true;
    },
    nodeId: (selector) => {
      const element = state.document?.querySelector(selector);
      const index = element == null ? -1 : state.elements.indexOf(element);

      if (index < 0) throw new Error(`the frame renders no ${selector}`);

      return `n${String(index)}`;
    },
    pointer: (type, on, init = {}) => {
      post({
        kind: 'pointer',
        type,
        point: { x: init.x ?? 0, y: init.y ?? 0 },
        button: 0,
        buttons: type === 'down' ? 1 : 0,
        ...(on === undefined || type === 'leave'
          ? {}
          : { nodeId: frame.nodeId(on) }),
        ...(init.pseudo === undefined ? {} : { pseudo: init.pseudo }),
        ...modifiersOf(init),
      });
    },
    wheel: (point, delta, modifiers) => {
      post({
        kind: 'wheel',
        point,
        deltaX: delta.deltaX ?? 0,
        deltaY: delta.deltaY ?? 0,
        deltaMode: 0,
        ...modifiersOf(modifiers),
      });
    },
    key: (type, key, modifiers) => {
      post({
        kind: 'key',
        type,
        key,
        code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`,
        repeat: false,
        ...modifiersOf(modifiers),
      });
    },
    focus: (focused) => post({ kind: 'focus', focused }),
    lay: (layout) => {
      state.layout = { ...state.layout, ...layout };
      if (state.rendered) frame.sendScene();
    },
    close: () => {
      state.port?.close();
      state.closed = true;
    },
  };

  const onInit = (content: FrameContent): void => {
    if (content.kind === 'markup') {
      frame.render(content.markup, 'markup');

      return;
    }

    const behaviour = options.module?.(content.module) ?? { fails: true };

    if ('mounts' in behaviour) {
      moduleLayout = behaviour.layout;
      frame.render(behaviour.mounts, 'module');

      return;
    }

    if (content.fallback === undefined) {
      post({ kind: 'error', message: 'the module did not load' });

      return;
    }

    frame.render(content.fallback, 'fallback');
  };

  const onMessage = (data: AppMessage): void => {
    received.push(data);

    if (!auto) return;

    if (data.kind === 'init') onInit(data.content);
    if (data.kind === 'measure' && state.rendered) frame.sendScene();
  };

  /** Whether the runtime listens yet: it starts after the document loads. */
  let listening = false;

  // The frame's window, as far as the app reaches it: the connect message.
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: {
      postMessage: (
        data: unknown,
        _origin: string,
        transfer?: readonly MessagePort[],
      ) => {
        const message = data as { papercraft?: unknown; kind?: unknown };
        const port = transfer?.[0];

        if (message.papercraft !== 1 || message.kind !== 'connect') return;
        if (port === undefined) return;
        // As the runtime: a `connect` before it listens is lost.
        if (!listening) return;

        state.port = port;
        port.addEventListener('message', (event: MessageEvent) => {
          const app = event.data as AppMessage;

          if (app.kind === 'init') state.init = app;
          onMessage(app);
        });
        port.addEventListener('close', () => {
          state.closed = true;
        });
        port.start();
        if (auto) frame.ready();
      },
    },
  });

  // As the runtime: the document loads first, and its boot script imports
  // the runtime after, which then listens and says so.
  setTimeout(() => {
    iframe.dispatchEvent(new window.Event('load'));
    setTimeout(() => {
      listening = true;
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: { papercraft: 1, kind: 'hello' },
          source: iframe.contentWindow as never,
        }),
      );
    }, 0);
  }, 0);

  return frame;
};

/** Attaches a fake frame to every preview iframe the app inserts. */
export const fakeFrames = (
  window: HappyWindow,
  options: FakeOptions = {},
): FakeFrames => {
  const all: FakeFrame[] = [];
  const seen = new WeakSet<Element>();

  const scan = (root: Element): void => {
    for (const iframe of root.querySelectorAll('iframe')) {
      if (seen.has(iframe)) continue;
      seen.add(iframe);
      all.push(attach(window, iframe as HTMLIFrameElement, options));
    }
  };

  // happy-dom holds a MutationObserver's callback only through a WeakRef, so
  // a garbage collection can silently end the observer: every lookup scans
  // the document as well.
  const observer = new window.MutationObserver(() =>
    scan(window.document.body),
  );
  observer.observe(window.document.body, { childList: true, subtree: true });

  const latest = (root: Node = window.document.body) => {
    scan(window.document.body);

    return [...all]
      .reverse()
      .find((frame) => frame.iframe.isConnected && root.contains(frame.iframe));
  };

  return {
    all,
    latest,
    next: async (root, holds = (frame) => frame.rendered) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        scan(window.document.body);

        const frame = latest(root);

        if (frame !== undefined && holds(frame)) return frame;

        await new Promise((done) => setTimeout(done, 2));
      }

      throw new Error('no preview frame came');
    },
    dispose: () => {
      observer.disconnect();
      for (const frame of all) frame.close();
    },
  };
};
