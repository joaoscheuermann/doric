import type { DesktopPush } from 'desktop/protocol';

/** The `doric:desktop:push` channel (`desktop/client`'s DESKTOP_PUSH_CHANNEL). */
export const DESKTOP_PUSH_CHANNEL = 'doric:desktop:push';

export interface PushTarget {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/** Sends one push to a window; a destroyed window is skipped. */
export const push = (target: PushTarget, payload: DesktopPush): void => {
  if (!target.isDestroyed()) {
    target.send(DESKTOP_PUSH_CHANNEL, payload);
  }
};
