// Drives the program frame's runtime as the app does: a fresh happy-dom
// window plays the frame, the runtime starts in it, and the app's end of a
// real `MessageChannel` is handed over with the `connect` window message.
// Every message the frame sends must parse with the app's own
// `frameMessage`; one that does not is a failure of the test.

import { Window } from 'happy-dom';

import {
  type FrameProtocol,
  frameMessage,
  PROGRAM_PROTOCOL,
  type ProgramAppMessage,
  type ProgramFrameMessage,
} from '../../../src/client/frame-protocol.js';
import { startProgramFrame } from '../../../src/client/frames/openui/runtime.js';
import type { FrameWindow } from '../../../src/client/frames/preview/shell.js';

/** A program frame (`M` = `ProgramFrameMessage`). */
export interface Frame<
  M extends { readonly kind: string } = ProgramFrameMessage,
> {
  readonly win: FrameWindow;
  readonly document: Document;
  /** The protocol the frame's entry speaks. */
  readonly protocol: FrameProtocol;
  /** Every frame message so far, parsed with the frame's protocol. */
  readonly messages: M[];
  /** Frame messages the app's schema refused. */
  readonly invalid: unknown[];
  readonly send: (message: ProgramAppMessage | Record<string, unknown>) => void;
  /**
   * The first message from index `from` on that `accept`s, waiting for it
   * when it has not arrived.
   */
  readonly waitFor: <T extends M>(
    accept: (message: M) => message is T,
    from?: number,
  ) => Promise<T>;
  /** Lets queued messages and microtasks settle. */
  readonly settle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** `kind` for the messages of a program frame. */
export const programKind =
  <K extends ProgramFrameMessage['kind']>(wanted: K) =>
  (
    message: ProgramFrameMessage,
  ): message is Extract<ProgramFrameMessage, { kind: K }> =>
    message.kind === wanted;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export interface OpenOptions {
  /** Runs on the window before the runtime starts. */
  readonly before?: (win: FrameWindow) => void;
  /** Whether the harness connects; true by default. */
  readonly connect?: boolean;
}

/** A program frame: `startProgramFrame` starts with `sheets`. */
export interface ProgramOpenOptions extends OpenOptions {
  readonly protocol?: FrameProtocol;
  /** The CSS texts the frame is started with (`[]` by default). */
  readonly sheets?: readonly string[];
}

/** A frame, connected (`ready` received) unless `connect` is false. */
export async function openFrame(
  options: ProgramOpenOptions = {},
): Promise<Frame> {
  const protocol: FrameProtocol = options.protocol ?? PROGRAM_PROTOCOL;
  const win = new Window({
    url: 'https://frame.test/',
    settings: { disableCSSFileLoading: true },
  }) as unknown as FrameWindow;

  options.before?.(win);
  startProgramFrame(win, options.sheets ?? []);

  type Message = { readonly kind: string };
  const channel = new MessageChannel();
  const messages: Message[] = [];
  const invalid: unknown[] = [];
  const waiters = new Set<() => void>();

  channel.port1.onmessage = (event: MessageEvent) => {
    const parsed: Message | undefined = frameMessage(event.data, protocol);

    if (parsed === undefined) invalid.push(event.data);
    else messages.push(parsed);

    for (const wake of [...waiters]) wake();
  };

  const waitFor = <T extends Message>(
    accept: (message: Message) => message is T,
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

  const frame: Frame<Message> = {
    win,
    document: win.document,
    protocol,
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
    await waitFor((message): message is Message => message.kind === 'ready');
  }

  return frame as Frame;
}

/** Posts the `connect` window message, with `port` when given. */
export const connect = (
  frame: Pick<Frame<{ readonly kind: string }>, 'win' | 'protocol'>,
  port?: MessagePort,
  data: unknown = { papercraft: frame.protocol, kind: 'connect' },
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
