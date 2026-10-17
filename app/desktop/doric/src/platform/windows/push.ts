import type { DesktopPush } from 'desktop/protocol';

/** The `doric:desktop:push` channel (`desktop/client`'s DESKTOP_PUSH_CHANNEL). */
export const DESKTOP_PUSH_CHANNEL = 'doric:desktop:push';

export interface PushTarget {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  readonly mainFrame?: {
    readonly url: string;
    readonly detached: boolean;
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

/** Sends one push to a window; a destroyed window is skipped. */
export const push = (target: PushTarget, payload: DesktopPush): void => {
  if (target.isDestroyed()) return;
  try {
    const frame = target.mainFrame;
    if (frame?.detached || frame?.isDestroyed()) return;
    (frame ?? target).send(DESKTOP_PUSH_CHANNEL, payload);
  } catch (error) {
    // A frame can disappear between the lifetime check and the native send.
    if (
      error instanceof Error &&
      /Render frame was disposed|Object has been destroyed/.test(error.message)
    )
      return;
    throw error;
  }
};
