// `window.doric.desktop` (decision 71, section 14.1): the window's one way to
// reach main, over exactly two channels. Bundled into the sandboxed preload,
// so it imports nothing but Electron at run time.

import type {
  BridgeCallEnvelope,
  BridgeResultPayload,
  BridgeStreamEvent,
  CloseAnswer,
  CloseRequest,
  DesktopPush,
  DoricDesktopApi,
  WindowCatalog,
  WindowChrome,
  WindowDescription,
  WindowFailure,
} from 'desktop-client/protocol';

/** = `desktop-client`'s DESKTOP_CHANNEL and DESKTOP_PUSH_CHANNEL (a test pins it). */
export const DESKTOP_CHANNEL = 'doric:desktop';
export const DESKTOP_PUSH_CHANNEL = 'doric:desktop:push';

export interface PreloadIpc {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void;
}

export interface DesktopBinding {
  readonly api: DoricDesktopApi;
}

export interface MetaDocument {
  querySelector(
    selector: string,
  ): { getAttribute(name: string): string | null } | null;
}

/** The client generation the shell was rendered with, read at call time. */
const generationOf = (
  document: MetaDocument | undefined,
): number | undefined => {
  const content = document
    ?.querySelector('meta[name="doric-generation"]')
    ?.getAttribute('content');

  if (content === null || content === undefined || content === '') {
    return undefined;
  }

  const generation = Number(content);

  return Number.isInteger(generation) ? generation : undefined;
};

export const createDesktopApi = (
  ipc: PreloadIpc,
  documentOf: () => MetaDocument | undefined = () => undefined,
): DesktopBinding => {
  const request = (payload: Record<string, unknown>): Promise<unknown> => {
    const generation = generationOf(documentOf());

    return ipc.invoke(DESKTOP_CHANNEL, {
      ...payload,
      ...(generation === undefined ? {} : { generation }),
    });
  };
  const streams = new Map<string, (event: BridgeStreamEvent) => void>();
  const chromeListeners = new Set<(chrome: WindowChrome) => void>();
  let closeHandler:
    | ((request: CloseRequest) => Promise<CloseAnswer | undefined>)
    | undefined;

  const answerClose = async (
    id: string,
    closeRequest: CloseRequest,
  ): Promise<void> => {
    let answer: CloseAnswer = { allow: true };

    if (closeRequest.phase === 'close') {
      if (closeHandler !== undefined) {
        try {
          answer = (await closeHandler(closeRequest)) ?? { allow: true };
        } catch {
          // A failing veto never traps the window.
          answer = { allow: true };
        }
      }
    } else {
      const handler = closeHandler;

      await Promise.allSettled(
        handler === undefined ? [] : [handler(closeRequest)],
      );
    }

    await request({ op: 'closeAnswer', id, answer }).catch(() => undefined);
  };

  ipc.on(DESKTOP_PUSH_CHANNEL, (_event, payload) => {
    const push = payload as DesktopPush;

    switch (push.type) {
      case 'close-requested':
        void answerClose(push.id, push.request);
        return;
      case 'chrome':
        for (const listener of [...chromeListeners]) {
          listener(push.chrome);
        }
        return;
      case 'event':
        streams.get(push.id)?.({ type: 'event', event: push.event });
        return;
      case 'end': {
        const listener = streams.get(push.id);

        streams.delete(push.id);
        listener?.(
          push.error === undefined
            ? { type: 'end' }
            : { type: 'end', error: push.error },
        );
        return;
      }
    }
  });

  const api: DoricDesktopApi = {
    describeWindow: () =>
      request({ op: 'describeWindow' }) as Promise<WindowDescription>,
    ready: async () => {
      await request({ op: 'ready' });
    },
    reportFailure: async (info: WindowFailure) => {
      await request({ op: 'reportFailure', info });
    },
    onCloseRequested: (handler) => {
      closeHandler = handler;

      return () => {
        if (closeHandler === handler) {
          closeHandler = undefined;
        }
      };
    },
    onChromeChanged: (listener) => {
      chromeListeners.add(listener);

      return () => {
        chromeListeners.delete(listener);
      };
    },
    catalog: () => request({ op: 'catalog' }) as Promise<WindowCatalog>,
    call: (envelope: BridgeCallEnvelope) =>
      request({ op: 'call', envelope }) as Promise<BridgeResultPayload>,
    cancel: (id: string) => {
      void request({ op: 'cancel', id }).catch(() => undefined);
    },
    subscribe: (envelope, listener) => {
      let open = true;

      streams.set(envelope.id, listener);
      void (
        request({ op: 'subscribe', envelope }) as Promise<BridgeResultPayload>
      )
        .then((result) => {
          if (!result.ok && open && streams.delete(envelope.id)) {
            listener({ type: 'end', error: result.error });
          }
        })
        .catch((error: unknown) => {
          if (open && streams.delete(envelope.id)) {
            listener({
              type: 'end',
              error: {
                code: 'unavailable',
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        });

      return () => {
        open = false;

        if (streams.delete(envelope.id)) {
          void request({ op: 'unsubscribe', id: envelope.id }).catch(
            () => undefined,
          );
        }
      };
    },
  };

  return { api };
};
