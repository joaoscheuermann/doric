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
// The registry is per window (this module's state): the canvas window is a
// window of its own, and its open revision never joins it (it stays live).

import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';

import { FRAME_SANDBOX } from './live-frame.js';

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
 * live outside the registry (the canvas window's open revision). The pointer
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

/* The warm frame (D6, PC30) ------------------------------------------------ */

/** A protocol-2 frame booted with no program, as a fence takes it over. */
export interface WarmFrame {
  readonly iframe: HTMLIFrameElement;
  /** The app's end of the channel, once the frame said `hello`. */
  readonly port: MessagePort | undefined;
  /** Whether the frame answered `ready` on that port. */
  readonly ready: boolean;
}

/** How the warm frame's handshake reads the frame: its protocol's messages. */
export interface WarmHandshake {
  readonly isHello: (data: unknown) => boolean;
  readonly connect: unknown;
  readonly isReady: (data: unknown) => boolean;
}

interface Warm {
  readonly iframe: HTMLIFrameElement;
  readonly src: string;
  port: MessagePort | undefined;
  ready: boolean;
  slot: LiveSlot | undefined;
  readonly detach: () => void;
}

let warm: Warm | undefined;

/** Where a warm frame waits: out of sight, outside any preview. */
const WARM_STYLE =
  'position: fixed; left: -10000px; top: 0; width: 1px; height: 1px; visibility: hidden; pointer-events: none;';

/**
 * Boots the window's one warm frame (D6): an iframe of `src`, handshaken up
 * to `ready` with no `init`, holding one of the window's live frames until a
 * papercraft fence takes it (`takeWarmFrame`) or previews used more recently
 * take its place. Returns its release: the frame goes unless a fence took it.
 */
export const bootWarmFrame = (
  document: Document,
  src: string,
  handshake: WarmHandshake,
): (() => void) => {
  if (warm !== undefined) return () => undefined;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('src', src);
  iframe.setAttribute('sandbox', FRAME_SANDBOX);
  iframe.setAttribute('title', 'papercraft');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('style', WARM_STYLE);
  iframe.className = 'papercraft-frame block border-0 bg-transparent';

  const view = document.defaultView;
  let current: Warm | undefined;

  const onReady = (event: MessageEvent): void => {
    if (current !== undefined && handshake.isReady(event.data))
      current.ready = true;
  };
  const onHello = (event: MessageEvent): void => {
    if (current === undefined || event.source !== iframe.contentWindow) return;
    if (!handshake.isHello(event.data)) return;

    current.port?.close();
    const channel = new MessageChannel();
    current.port = channel.port1;
    current.ready = false;
    channel.port1.addEventListener('message', onReady);
    channel.port1.start();
    iframe.contentWindow?.postMessage(handshake.connect, '*', [channel.port2]);
  };

  const booted: Warm = {
    iframe,
    src,
    port: undefined,
    ready: false,
    slot: undefined,
    detach: () => {
      view?.removeEventListener('message', onHello);
      booted.port?.removeEventListener('message', onReady);
    },
  };
  current = booted;

  const drop = (): void => {
    if (warm !== booted) return;
    warm = undefined;
    booted.detach();
    booted.slot?.leave();
    booted.port?.close();
    iframe.remove();
  };

  warm = booted;
  view?.addEventListener('message', onHello);
  booted.slot = joinLiveFrames(`warm:${src}`, (live) => {
    if (!live) drop();
  });
  document.body.append(iframe);

  return drop;
};

/**
 * Hands the warm frame of `src` to the caller, which owns it from now on:
 * its iframe, the channel's port and whether it said `ready`. The frame
 * leaves the registry's count; the caller joins it under its own key.
 * `undefined` when there is none.
 */
export const takeWarmFrame = (src: string): WarmFrame | undefined => {
  const taken = warm;

  if (taken === undefined || taken.src !== src) return undefined;

  warm = undefined;
  taken.detach();
  taken.slot?.leave();

  return { iframe: taken.iframe, port: taken.port, ready: taken.ready };
};
