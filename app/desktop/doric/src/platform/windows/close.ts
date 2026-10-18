// The close protocol, main side (section 17.2): a veto phase without a
// deadline, then a flush phase bounded by WINDOW_FLUSH_DEADLINE_MS, then the
// real close. It replaces the settings window's flush handshake and serves
// every window.

import type { CloseAnswer, CloseRequest } from 'desktop/protocol';

import { type PushTarget, push } from './push';

/** = today's `settingsCloseFlushMs` (P11). */
export const WINDOW_FLUSH_DEADLINE_MS = 1_500;

export interface ClosingWindow {
  isDestroyed(): boolean;
  close(): void;
  on(
    event: 'close',
    listener: (event: { preventDefault(): void }) => void,
  ): void;
  readonly webContents: PushTarget;
}

/** Answers the windows send back with `closeAnswer`. */
export class CloseAnswers {
  readonly #waiting = new Map<string, (answer: CloseAnswer) => void>();
  #counter = 0;

  /** Sends a request and resolves with the window's answer. */
  ask(
    target: PushTarget,
    request: CloseRequest,
  ): {
    readonly answer: Promise<CloseAnswer>;
    readonly cancel: () => void;
  } {
    this.#counter += 1;
    const id = `close-${this.#counter}`;
    let cancel: () => void = () => undefined;
    const answer = new Promise<CloseAnswer>((resolve) => {
      this.#waiting.set(id, resolve);
      cancel = () => {
        this.#waiting.delete(id);
      };
    });

    push(target, { type: 'close-requested', id, request });

    return { answer, cancel };
  }

  /** A `closeAnswer` from the window; unknown IDs are ignored. */
  answer(id: string, answer: CloseAnswer): void {
    const resolve = this.#waiting.get(id);

    if (resolve !== undefined) {
      this.#waiting.delete(id);
      resolve(answer);
    }
  }
}

export interface CloseProtocolOptions {
  readonly answers: CloseAnswers;
  /** True while the app quits: every close is forced. */
  readonly quitting: () => boolean;
  /** A denied close (reason to diagnostics). */
  readonly denied?: (reason: string) => void;
  readonly flushDeadlineMs?: number;
  readonly now?: () => number;
}

/**
 * Holds every close of a window until its renderer answered. A second close
 * while one is pending, or a close during quit, is forced: the veto phase
 * allows it at once. A window whose renderer never answers the veto stays
 * open until it is closed again (risk R7).
 */
export const installCloseProtocol = (
  window: ClosingWindow,
  options: CloseProtocolOptions,
): void => {
  const deadlineMs = options.flushDeadlineMs ?? WINDOW_FLUSH_DEADLINE_MS;
  const now = options.now ?? Date.now;
  let released = false;
  let pending:
    | { cancel(): void; readonly forced: boolean; flushing: boolean }
    | undefined;

  const release = (): void => {
    released = true;

    if (!window.isDestroyed()) {
      window.close();
    }
  };

  const flush = async (): Promise<void> => {
    const deadline = now() + deadlineMs;
    const asked = options.answers.ask(window.webContents, {
      phase: 'flush',
      forced: false,
      deadline,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;

    await Promise.race([
      asked.answer,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      }),
    ]);
    clearTimeout(timer);
    asked.cancel();
  };

  const run = async (forced: boolean): Promise<void> => {
    const asked = options.answers.ask(window.webContents, {
      phase: 'close',
      forced,
      deadline: 0,
    });
    const current = { cancel: asked.cancel, forced, flushing: false };

    pending = current;

    const answer = await asked.answer;

    if (pending !== current) {
      return;
    }

    if (!answer.allow) {
      pending = undefined;
      options.denied?.(answer.reason);

      return;
    }

    current.flushing = true;
    await flush();
    pending = undefined;
    release();
  };

  window.on('close', (event) => {
    if (released || window.webContents.isDestroyed()) {
      return;
    }

    event.preventDefault();

    const forced = pending !== undefined || options.quitting();

    if (pending !== undefined) {
      // A forced close or a flush in progress already ends in the close.
      if (pending.forced || pending.flushing) {
        return;
      }

      // A second close forces: the pending veto is dropped.
      pending.cancel();
      pending = undefined;
    }

    void run(forced);
  });
};
