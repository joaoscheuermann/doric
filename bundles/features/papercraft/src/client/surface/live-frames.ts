// `live-frames.ts` — which previews of a window keep a live frame
// (isolamento.md, "Virtualização"; decision 2).
//
// Each live frame is a sandboxed iframe evaluating its own React, so a window
// keeps at most `LIVE_FRAME_LIMIT` of them: the previews used most recently.
// The others draw a stand-in (`stand-in.tsx`) from what their frame last
// reported (`frame-memory.ts`) and the snapshot taken of it (`snapshots.ts`).
//
// A preview is used when:
//
//   - its revision first appears in the window (published, or mounted the
//     first time) — a revision mounted again (the conversation re-rendering
//     it) keeps the place its last use gave it;
//   - the reader's pointer moves over it or presses on it;
//   - it is live and on screen: a visible live frame is in use for as long
//     as it is seen, so it outranks every live frame out of view.
//
// A dead preview merely scrolled into view is not used: scrolling back
// through the conversation never evicts the frames just used. Interacting
// with it promotes it, and the least recently used live frame dies.
//
// The registry is per window (this module's state): the canvas modal's open
// revision never joins it (it stays live).

import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';

/** The most previews one window keeps a live frame for. */
export const LIVE_FRAME_LIMIT = 3;

/** How many revisions the window remembers the last use of. */
const USE_MEMORY_LIMIT = 256;

interface Slot {
  readonly id: number;
  readonly key: string;
  stamp: number;
  visible: boolean;
  live: boolean;
  readonly notify: (live: boolean) => void;
}

/** One preview's place in the window's registry. */
export interface LiveSlot {
  /** Whether the preview holds one of the live frames. */
  readonly live: () => boolean;
  /** The reader used the preview (its pointer, a press). */
  readonly use: () => void;
  /** The preview came into view, or left it. */
  readonly visible: (visible: boolean) => void;
  /** The preview left the window. */
  readonly leave: () => void;
}

const slots = new Map<number, Slot>();
/** The last use of each revision seen in the window, oldest first. */
const lastUse = new Map<string, number>();
let clock = 0;
let ids = 0;

const stamp = (slot: Slot): void => {
  clock += 1;
  slot.stamp = clock;
  lastUse.delete(slot.key);
  lastUse.set(slot.key, clock);

  while (lastUse.size > USE_MEMORY_LIMIT) {
    const oldest = lastUse.keys().next().value;

    if (oldest === undefined) break;
    lastUse.delete(oldest);
  }
};

/** The visible live frames are in use now: they outrank the others. */
const refreshVisible = (): void => {
  const seen = [...slots.values()]
    .filter((slot) => slot.live && slot.visible)
    .sort((a, b) => a.stamp - b.stamp);

  for (const slot of seen) stamp(slot);
};

/** Hands the live frames to the most recently used slots. */
const rebalance = (): void => {
  const ranked = [...slots.values()].sort(
    (a, b) => b.stamp - a.stamp || b.id - a.id,
  );
  const changed: Slot[] = [];

  ranked.forEach((slot, index) => {
    const live = index < LIVE_FRAME_LIMIT;

    if (slot.live === live) return;
    slot.live = live;
    changed.push(slot);
  });

  for (const slot of changed) slot.notify(slot.live);
};

/** A use that may change who is live: the visible live frames first. */
const promote = (slot: Slot): void => {
  refreshVisible();
  stamp(slot);
  rebalance();
};

/**
 * Joins the window's registry for one revision (`key`). `notify` hears every
 * later change of the slot's liveness; the slot's own `live()` answers it
 * now.
 */
export const joinLiveFrames = (
  key: string,
  notify: (live: boolean) => void,
): LiveSlot => {
  ids += 1;

  const known = lastUse.get(key);
  const slot: Slot = {
    id: ids,
    key,
    stamp: known ?? 0,
    visible: false,
    live: false,
    notify,
  };

  slots.set(slot.id, slot);

  // A revision first appearing is a use; one seen before keeps its place.
  if (known === undefined) promote(slot);
  else rebalance();

  return {
    live: () => slot.live,
    use: () => {
      if (!slots.has(slot.id)) return;

      // A live frame used keeps its frame: only its rank moves.
      if (slot.live) stamp(slot);
      else promote(slot);
    },
    visible: (visible) => {
      if (!slots.has(slot.id) || slot.visible === visible) return;

      // A live frame was in use until it left the view, and is again from
      // the moment it comes back; a dead one is only seen.
      if (slot.live) refreshVisible();
      slot.visible = visible;
      if (slot.live) refreshVisible();
    },
    leave: () => {
      if (!slots.delete(slot.id)) return;
      rebalance();
    },
  };
};

/**
 * One preview's liveness in the window, for as long as the component is
 * mounted. `key` is the revision on screen; `undefined` keeps the preview
 * live outside the registry (the open revision of a node's modal). The pointer
 * moving or pressing over `element` uses the preview, and its visibility is
 * observed when the window has an `IntersectionObserver`.
 */
export const useLiveFrame = (
  key: string | undefined,
  element: RefObject<HTMLElement | null>,
): { readonly live: boolean; readonly use: () => void } => {
  const [state, setState] = useState<{
    readonly slot: LiveSlot | undefined;
    readonly live: boolean;
  }>({ slot: undefined, live: true });

  // Joined before the surface's frame mounts (its content arrives in a
  // passive effect), so a preview that joins dead never starts a frame.
  useLayoutEffect(() => {
    if (key === undefined) {
      setState({ slot: undefined, live: true });

      return;
    }

    let joined: LiveSlot | undefined;
    const notify = (live: boolean): void => {
      // The join itself answers the slot's first liveness below.
      if (joined === undefined) return;
      setState((current) =>
        current.slot === joined && current.live !== live
          ? { slot: joined, live }
          : current,
      );
    };

    joined = joinLiveFrames(key, notify);
    setState({ slot: joined, live: joined.live() });

    const slot = joined;
    const target = element.current;
    const onPointer = (): void => slot.use();

    target?.addEventListener('pointermove', onPointer, { capture: true });
    target?.addEventListener('pointerdown', onPointer, { capture: true });

    const observer =
      target === null || typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver((entries) => {
            const entry = entries.at(-1);

            if (entry !== undefined) slot.visible(entry.isIntersecting);
          });

    if (target !== null) observer?.observe(target);

    return () => {
      observer?.disconnect();
      target?.removeEventListener('pointermove', onPointer, { capture: true });
      target?.removeEventListener('pointerdown', onPointer, { capture: true });
      slot.leave();
    };
  }, [key, element]);

  const slot = state.slot;
  const use = useCallback(() => slot?.use(), [slot]);

  return { live: key === undefined ? true : state.live, use };
};
