// The live output a `terminal` call's row shows (bundle isolation 5(b),
// change 4, T-3; the rules of the chat's `stores/live-terminals.ts`): the
// row watches its terminal's output only while the terminal runs, keeps the
// last 32,000 characters, and draws at most every 50 ms.

import { useEffect, useState } from 'react';

import { appendCapped } from '../domain/live-terminal.js';
import { type Terminal, unseenOutput } from '../domain/terminals.js';
import type { TerminalWatchApi } from '../output-watch.js';

/** The least time between two drawings of a row's live output. */
export const OUTPUT_THROTTLE_MS = 50;

/** Whether a terminal still runs, so its output can still grow. */
const runs = (terminal: Terminal | undefined): terminal is Terminal =>
  terminal !== undefined &&
  (terminal.state === 'starting' || terminal.state === 'running');

/**
 * The output of `terminal` the row has seen, or `undefined` before any.
 * - Watches `watches.watch(id, 0, …)` only while the terminal is `starting`
 *   or `running`; the watch closes when it exits or the row leaves, and the
 *   output seen so far stays.
 * - Keeps the last `LIVE_OUTPUT_LIMIT` characters.
 * - Draws a chunk at once when the last drawing is `OUTPUT_THROTTLE_MS` old,
 *   else once that time has passed, with every chunk come meanwhile.
 */
export const useLiveOutput = (
  watches: TerminalWatchApi,
  terminal: Terminal | undefined,
): string | undefined => {
  const [shown, setShown] = useState<
    { readonly id: string; readonly output: string } | undefined
  >(undefined);
  const watchedId = runs(terminal) ? terminal.id : undefined;

  useEffect(() => {
    if (watchedId === undefined) return;
    let output = '';
    let sequence = 0;
    let drawnAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draw = () => {
      timer = undefined;
      drawnAt = Date.now();
      setShown({ id: watchedId, output });
    };
    const changed = () => {
      if (timer !== undefined) return;
      const elapsed = Date.now() - drawnAt;
      if (elapsed >= OUTPUT_THROTTLE_MS) draw();
      else timer = setTimeout(draw, OUTPUT_THROTTLE_MS - elapsed);
    };
    const stop = watches.watch(watchedId, 0, (update) => {
      if (update.kind === 'error') return;
      if (update.kind === 'snapshot') {
        output = appendCapped('', update.data);
      } else if (update.sequence > sequence) {
        output = appendCapped(
          output,
          unseenOutput(update.data, update.sequence, sequence),
        );
      } else return;
      sequence = update.sequence;
      changed();
    });
    return () => {
      stop();
      // What came within the last 50 ms is drawn still: it is the end of
      // what the terminal printed.
      if (timer !== undefined) {
        clearTimeout(timer);
        draw();
      }
    };
  }, [watches, watchedId]);

  return shown !== undefined && shown.id === terminal?.id
    ? shown.output
    : undefined;
};
