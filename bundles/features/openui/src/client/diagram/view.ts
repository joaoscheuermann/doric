// What the diagram views share (openui-diagrams-phase2.md F17): one draw per
// mount and key, late results dropped, and the notes of phase 1's state table.

import { useEffect, useRef, useState } from 'react';

/** A draw's outcome for the current key. */
export type Drawn<D> =
  | { readonly state: 'pending' }
  | { readonly state: 'drawn'; readonly value: D }
  | { readonly state: 'failed'; readonly message: string };

/** The longest part of a draw's error the note shows, in characters. */
const MAX_FAILURE = 200;

const PENDING = { state: 'pending' } as const;

/**
 * Runs `draw` once per `key` while `drawable`, drops results that arrive after the
 * key changed or the component unmounted, and cuts a failure's message to 200 characters.
 *
 * A React hook. Returns `pending` while not drawable and until the current key's draw settles;
 * `drawn` with its value, or `failed` with the rejection's message (an `Error`'s `message`,
 * else `String(reason)`), for the current key only. A new key returns `pending` until its own
 * draw settles. Never throws.
 */
export const useDrawn = <D>(
  key: string,
  drawable: boolean,
  draw: () => Promise<D>,
): Drawn<D> => {
  const [settled, setSettled] = useState<
    { readonly key: string; readonly drawn: Drawn<D> } | undefined
  >(undefined);

  // The effect reads the render's `draw`; it runs again only when the key does.
  const latest = useRef(draw);
  latest.current = draw;

  useEffect(() => {
    if (!drawable) return;
    let live = true;
    latest.current().then(
      (value) => {
        if (live) setSettled({ key, drawn: { state: 'drawn', value } });
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        const message = [...reason].slice(0, MAX_FAILURE).join('');
        if (live) setSettled({ key, drawn: { state: 'failed', message } });
      },
    );
    return () => {
      live = false;
    };
  }, [key, drawable]);

  return drawable && settled?.key === key ? settled.drawn : PENDING;
};

/** Phase 1's notes, shared by the views. */
export const NOTES = {
  noContext: 'Diagrams are drawn only in the conversation.',
  streaming: 'The diagram is drawn when its fence is complete.',
  pending: 'Drawing the diagram…',
  failed: 'This diagram could not be drawn: ',
} as const;
