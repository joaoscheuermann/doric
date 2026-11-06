// `live-frame.tsx` — the live boundary of a preview: one sandboxed iframe
// running the bundle's preview runtime, and the one `MessageChannel` the app
// speaks to it through (`frame-protocol.ts`,
// docs/architecture/bundles/papercraft/isolamento.md).
//
// The iframe is `sandbox="allow-scripts"` without `allow-same-origin`: an
// opaque origin, its own realm, no preload and no reach into the app. Each
// time its document's runtime says `hello` (from that iframe's window only),
// the app opens a fresh channel and posts the `connect` window message with
// the second port transferred; from then on it listens to that port only,
// so nothing else posted to the app's window, or on
// another channel, is ever read as the frame's word. Every message on the
// port is parsed with `frameMessage` — the frame runs the Project's code —
// and what does not parse is dropped, as is anything before `ready`.
//
// After `ready`, the frame is initialised with the content once the surface
// knows it (`init`), and from then on follows the props: the theme, the
// input capture, the hidden layers, the cursor lock and each measure
// request are posted when they change. When the component goes the revision
// is disposed (`dispose`) and the port closed, and the iframe leaves with it.
//
// Everything a dead frame's stand-in needs to draw the same revision — its
// scene, size, layout and mode — is reported out (`onMessage`) and kept by
// the surface (`frame-memory.ts`); nothing outside this component holds the
// iframe or its port.

import { type CSSProperties, useEffect, useLayoutEffect, useRef } from 'react';

import {
  type AppMessage,
  connectMessage,
  type FrameContent,
  type FrameMessage,
  type FrameProtocol,
  frameMessage,
  type InputCapture,
  isHello,
  PROGRAM_PROTOCOL,
  PROTOCOL,
  type PreviewTheme,
  type ProgramAppMessage,
  type ProgramFrameMessage,
} from '../frame-protocol.js';
import { takeWarmFrame } from './live-frames.js';

/** The cursor the app locks every element of the preview to. */
export interface FrameCursor {
  readonly locked: boolean;
  /** A CSS cursor keyword (`crosshair`, `grab`…); `default` when absent. */
  readonly cursor?: string;
}

/** What a protocol-2 frame is told (D6): its `init` and its current `program`. */
export interface ProgramContent {
  readonly init: Omit<
    Extract<ProgramAppMessage, { kind: 'init' }>,
    'kind' | 'theme' | 'capture'
  >;
  readonly message: Omit<
    Extract<ProgramAppMessage, { kind: 'program' }>,
    'kind'
  >;
}

export interface LiveFrameProps {
  /** The frame document (`frameDocumentUrl`). */
  readonly src: string;
  /** What to render; the frame is initialised once it is known. */
  readonly content: FrameContent | undefined;
  readonly theme: PreviewTheme;
  readonly capture: InputCapture;
  /** The ids of the last scene's nodes to hide. */
  readonly hidden: readonly string[];
  readonly cursor: FrameCursor;
  /** Bumped to ask the frame for a fresh scene. */
  readonly measureRequest: number;
  /** The iframe's box, in content pixels. */
  readonly style?: CSSProperties;
  /** Every validated message of the frame after `ready`. */
  readonly onMessage: (message: FrameMessage | ProgramFrameMessage) => void;
  readonly title?: string;
  /** The frame's protocol: 1 (the default) for `previewFrameSrc`, 2 for `programFrameSrc`. */
  readonly protocol?: FrameProtocol;
  /**
   * Protocol 2: what `init` and `program` carry; the frame is initialised
   * once it is known, and `program` is posted again on each change.
   */
  readonly program?: ProgramContent;
  /** Protocol 2: take the window's warm frame, when it has one (D6). */
  readonly adopt?: boolean;
}

/** The only sandbox token a preview frame gets. */
export const FRAME_SANDBOX = 'allow-scripts';

/** What the app last told the current frame document. */
interface Sent {
  ready: boolean;
  initialised: boolean;
  theme?: PreviewTheme;
  capture?: InputCapture;
  hidden: string;
  cursor: string;
  measure: number;
  /** Protocol 2: the last `program` posted, as JSON. */
  program?: string;
}

const freshSent = (): Sent => ({
  ready: false,
  initialised: false,
  hidden: '',
  cursor: 'unlocked',
  measure: 0,
});

const cursorKeyOf = (cursor: FrameCursor): string =>
  cursor.locked ? `locked:${cursor.cursor ?? ''}` : 'unlocked';

export function LiveFrame({
  src,
  content,
  theme,
  capture,
  hidden,
  cursor,
  measureRequest,
  style,
  onMessage,
  title = 'preview',
  protocol = PROTOCOL,
  program,
  adopt = false,
}: LiveFrameProps) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const holder = useRef<HTMLSpanElement>(null);
  /** Protocol 2's iframe, made (or adopted) outside React's tree. */
  const own = useRef<HTMLIFrameElement | undefined>(undefined);
  const port = useRef<MessagePort | undefined>(undefined);
  const sent = useRef<Sent>(freshSent());
  /** What the frame mounts with: a new protocol, entry or warm frame is a new frame (its `key`). */
  const mount = useRef({ protocol, adopt, src, title, style });

  // The props are read when the frame is ready and on every render, so a
  // prop change never reconnects the frame.
  const latest = useRef({
    content,
    theme,
    capture,
    hidden,
    cursor,
    measureRequest,
    onMessage,
    program,
  });
  latest.current = {
    content,
    theme,
    capture,
    hidden,
    cursor,
    measureRequest,
    onMessage,
    program,
  };

  /** Posts what the frame does not know yet. */
  const sync = useRef(() => {
    const channel = port.current;
    const state = sent.current;
    const props = latest.current;

    if (channel === undefined || !state.ready) return;

    const post = (message: AppMessage | ProgramAppMessage) =>
      channel.postMessage(message);

    if (protocol === PROGRAM_PROTOCOL) {
      if (props.program === undefined) return;

      if (!state.initialised) {
        post({
          kind: 'init',
          ...props.program.init,
          theme: props.theme,
          capture: props.capture,
        });
        state.initialised = true;
        state.theme = props.theme;
        state.capture = props.capture;
        state.measure = props.measureRequest;
      }

      const next = JSON.stringify(props.program.message);

      if (state.program !== next) {
        state.program = next;
        post({ kind: 'program', ...props.program.message });
      }
    } else if (!state.initialised) {
      if (props.content === undefined) return;

      post({
        kind: 'init',
        content: props.content,
        theme: props.theme,
        capture: props.capture,
      });
      state.initialised = true;
      state.theme = props.theme;
      state.capture = props.capture;
      // The first scene follows the mount: no measure is owed.
      state.measure = props.measureRequest;
    }

    if (state.theme !== props.theme) {
      state.theme = props.theme;
      post({ kind: 'theme', theme: props.theme });
    }

    if (state.capture !== props.capture) {
      state.capture = props.capture;
      post({ kind: 'capture', capture: props.capture });
    }

    const hiddenKey = props.hidden.join(' ');

    if (state.hidden !== hiddenKey) {
      state.hidden = hiddenKey;
      post({ kind: 'hidden', ids: [...props.hidden] });
    }

    const cursorKey = cursorKeyOf(props.cursor);

    if (state.cursor !== cursorKey) {
      state.cursor = cursorKey;
      post({
        kind: 'cursor',
        locked: props.cursor.locked,
        ...(props.cursor.locked && props.cursor.cursor !== undefined
          ? { cursor: props.cursor.cursor }
          : {}),
      });
    }

    if (state.measure !== props.measureRequest) {
      state.measure = props.measureRequest;
      post({ kind: 'measure' });
    }
  });

  // Bound before the frame can speak: a layout effect runs right after the
  // element is inserted, before its document can run a script.
  useLayoutEffect(() => {
    const { protocol, adopt, src, title, style } = mount.current;
    let element: HTMLIFrameElement | null = iframe.current;
    let adopted: ReturnType<typeof takeWarmFrame>;

    if (protocol === PROGRAM_PROTOCOL) {
      // Protocol 2's iframe lives outside React's tree, so the window's warm
      // frame, already handshaken, can become this one (D6).
      adopted = adopt ? takeWarmFrame(src) : undefined;
      element =
        adopted?.iframe ??
        (holder.current?.ownerDocument ?? document).createElement('iframe');
      element.removeAttribute('style');
      element.removeAttribute('aria-hidden');
      element.removeAttribute('tabindex');
      if (element.getAttribute('src') !== src) element.setAttribute('src', src);
      element.setAttribute('sandbox', FRAME_SANDBOX);
      element.setAttribute('title', title);
      element.className = 'papercraft-frame block border-0 bg-transparent';
      Object.assign(element.style, style ?? {});
      own.current = element;
      holder.current?.append(element);
    }

    if (element === null) return;

    const frame = element;

    const close = (): void => {
      const channel = port.current;

      port.current = undefined;
      if (channel === undefined) return;

      if (sent.current.initialised) {
        channel.postMessage({ kind: 'dispose' } satisfies AppMessage);
      }

      channel.close();
    };

    /** Listens to the frame on `channel`, the app's end of its port. */
    const listen = (channel: MessagePort): void => {
      port.current = channel;
      channel.addEventListener('message', (event: MessageEvent) => {
        if (port.current !== channel) return;

        const message =
          protocol === PROGRAM_PROTOCOL
            ? frameMessage(event.data, PROGRAM_PROTOCOL)
            : frameMessage(event.data);

        if (message === undefined) return;

        if (message.kind === 'ready') {
          if (sent.current.ready) return;

          sent.current.ready = true;
          sync.current();

          return;
        }

        // Nothing the frame says counts before its handshake.
        if (!sent.current.ready) return;

        latest.current.onMessage(message);
      });
      channel.start();
    };

    const onHello = (event: MessageEvent): void => {
      const target = frame.contentWindow;

      // Only this iframe's document is heard, and only its `hello`: the
      // runtime says it once it listens, which the document's `load` event
      // does not tell (its boot script imports the runtime after).
      if (target === null || event.source !== target) return;
      if (!isHello(event.data, protocol)) return;

      // Each `hello` is a document that started: a new channel, a new
      // handshake, a new `init`.
      close();
      sent.current = freshSent();

      const channel = new MessageChannel();

      listen(channel.port1);

      // The frame's origin is opaque, so no origin can be named: the port is
      // fresh, and the frame document only ever navigates to the frame URL.
      target.postMessage(connectMessage(protocol), '*', [channel.port2]);
    };

    // An adopted warm frame is handshaken already, or about to be.
    if (adopted?.port !== undefined) {
      sent.current = freshSent();
      listen(adopted.port);
      if (adopted.ready) {
        sent.current.ready = true;
        sync.current();
      }
    }

    const view = frame.ownerDocument.defaultView;

    view?.addEventListener('message', onHello);

    return () => {
      view?.removeEventListener('message', onHello);
      // The revision unmounts before the iframe leaves the document.
      close();
      if (own.current !== undefined) {
        own.current.remove();
        own.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (own.current !== undefined)
      Object.assign(own.current.style, style ?? {});
    sync.current();
  });

  return protocol === PROGRAM_PROTOCOL ? (
    <span ref={holder} className="contents" />
  ) : (
    <iframe
      ref={iframe}
      src={src}
      title={title}
      sandbox={FRAME_SANDBOX}
      className="papercraft-frame block border-0 bg-transparent"
      style={style}
    />
  );
}
