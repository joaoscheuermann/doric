// Drives the preview frame's runtime as the app does: a fresh happy-dom
// window plays the frame, the runtime starts in it, and the app's end of a
// real `MessageChannel` is handed over with the `connect` window message.
// Every message the frame sends must parse with the app's own
// `frameMessage`; one that does not is a failure of the test.

import { Window } from 'happy-dom';

import {
  type AppMessage,
  type FrameMessage,
  frameMessage,
  PROTOCOL,
} from '../../../src/client/frame-protocol.js';
import {
  type FrameWindow,
  startPreviewFrame,
} from '../../../src/client/frames/preview/runtime.js';

export interface Frame {
  readonly win: FrameWindow;
  readonly document: Document;
  /** Every frame message so far, parsed. */
  readonly messages: FrameMessage[];
  /** Frame messages the app's schema refused. */
  readonly invalid: unknown[];
  readonly send: (message: AppMessage | Record<string, unknown>) => void;
  /**
   * The first message from index `from` on that `accept`s, waiting for it
   * when it has not arrived.
   */
  readonly waitFor: <T extends FrameMessage>(
    accept: (message: FrameMessage) => message is T,
    from?: number,
  ) => Promise<T>;
  /** Lets queued messages and microtasks settle. */
  readonly settle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export const kind =
  <K extends FrameMessage['kind']>(wanted: K) =>
  (message: FrameMessage): message is Extract<FrameMessage, { kind: K }> =>
    message.kind === wanted;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export interface OpenOptions {
  /** Runs on the window before the runtime starts. */
  readonly before?: (win: FrameWindow) => void;
  /** Whether the harness connects; true by default. */
  readonly connect?: boolean;
}

/** A frame, connected (`ready` received) unless `connect` is false. */
export const openFrame = async (options: OpenOptions = {}): Promise<Frame> => {
  const win = new Window({
    url: 'https://frame.test/',
    settings: { disableCSSFileLoading: true },
  }) as unknown as FrameWindow;

  options.before?.(win);
  startPreviewFrame(win);

  const channel = new MessageChannel();
  const messages: FrameMessage[] = [];
  const invalid: unknown[] = [];
  const waiters = new Set<() => void>();

  channel.port1.onmessage = (event: MessageEvent) => {
    const parsed = frameMessage(event.data);

    if (parsed === undefined) invalid.push(event.data);
    else messages.push(parsed);

    for (const wake of [...waiters]) wake();
  };

  const waitFor = <T extends FrameMessage>(
    accept: (message: FrameMessage) => message is T,
    from = 0,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const look = (): boolean => {
        const found = messages.slice(from).find(accept);

        if (found === undefined) return false;
        waiters.delete(wake);
        clearTimeout(timer);
        resolve(found);

        return true;
      };
      const wake = (): void => {
        look();
      };
      const timer = setTimeout(() => {
        waiters.delete(wake);
        reject(
          new Error(
            `No such frame message; got ${JSON.stringify(messages.map((message) => message.kind))}`,
          ),
        );
      }, 3000);

      if (!look()) waiters.add(wake);
    });

  const frame: Frame = {
    win,
    document: win.document,
    messages,
    invalid,
    send: (message) => channel.port1.postMessage(message),
    waitFor,
    settle: async () => {
      await tick();
      await tick();
    },
    close: async () => {
      channel.port1.close();
      channel.port2.close();
      await (
        win as unknown as { happyDOM: { close(): Promise<void> } }
      ).happyDOM.close();
    },
  };

  if (options.connect !== false) {
    connect(frame, channel.port2);
    await waitFor(kind('ready'));
  }

  return frame;
};

/** Posts the `connect` window message, with `port` when given. */
export const connect = (
  frame: Frame,
  port?: MessagePort,
  data: unknown = { papercraft: PROTOCOL, kind: 'connect' },
): void => {
  const win = frame.win as unknown as {
    MessageEvent: typeof MessageEvent;
    dispatchEvent(event: Event): boolean;
  };

  win.dispatchEvent(
    new win.MessageEvent('message', {
      data,
      ports: port === undefined ? [] : [port],
    }),
  );
};

/** A revision fixture's URL, `variant` picking what it renders. */
export const revisionUrl = (variant = 'card'): string =>
  new URL(`./frame-revision.js?variant=${variant}`, import.meta.url).href;

/** What the fixture recorded on the frame's window. */
export const fixtureLog = (
  frame: Frame,
): { readonly mounts: readonly string[]; readonly unmounts: number } =>
  (
    frame.win as unknown as {
      papercraftFixture?: { mounts: string[]; unmounts: number };
    }
  ).papercraftFixture ?? { mounts: [], unmounts: 0 };

/** Gives an element a fixed layout box, as a browser would measure it. */
export const placeAt = (
  element: Element | null,
  box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): void => {
  if (element === null) throw new Error('No element to place.');

  (element as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () =>
      ({
        ...box,
        left: box.x,
        top: box.y,
        right: box.x + box.width,
        bottom: box.y + box.height,
        toJSON: () => box,
      }) as DOMRect;
};
