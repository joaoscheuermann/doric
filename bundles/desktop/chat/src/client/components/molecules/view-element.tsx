import { type JSX, useContext, useEffect, useRef } from 'react';

import {
  CHAT_BLOCK_CHOSEN_EVENT,
  type ChatBlockChosenDetail,
  type ChatInputView,
  type ChatToolView,
} from '../../../contracts/index.js';
import { ChatBlocksContext } from '../organisms/conversation/nodes/chat-block-node.js';

/** A registered element as the chat holds it: its `view`, and its own toggle. */
interface ViewHost {
  view?: ChatToolView | ChatInputView;
  toggle?: () => void;
}

/** The element one `ViewElement` holds, and whether its effect gave it back. */
interface Held {
  readonly tag: string;
  readonly ui: object;
  readonly toggleKey: string;
  readonly element: ViewHost;
  released: boolean;
}

/**
 * The element each `ViewElement` hosts, by its toggle key (the node key, or the
 * node key and the call id inside an activity group), so the conversation's
 * toggle key reaches the element's own `toggle()` (OD44, O2).
 */
const hostedViews = new Map<string, ViewHost>();

/**
 * Calls the `toggle()` of the element hosted under `toggleKey` when it defines
 * one; answers whether it did, so the caller applies the generic rule otherwise.
 */
export const toggleHostedView = (toggleKey: string): boolean => {
  const hosted = hostedViews.get(toggleKey);
  if (typeof hosted?.toggle !== 'function') return false;
  hosted.toggle();
  return true;
};

const chosenOf = (event: Event): boolean | undefined => {
  const detail = (event as CustomEvent<ChatBlockChosenDetail | undefined>)
    .detail;
  return typeof detail?.chosen === 'boolean' ? detail.chosen : undefined;
};

/**
 * The host of one registered element with a `view` (`chat.views/v1` 1.2.0). It
 * creates the element through `ui/v1` with `{ view }`, sets `view` again when
 * it changes without creating the element again, and disposes it through
 * `ui/v1` when it leaves. The reader's choice the element reports with
 * `chat-block-chosen` is stopped at the frame and handed to `onChosen`. A
 * creation that fails is logged once and draws nothing.
 *
 * An element given back is disposed one microtask later unless the same host
 * took it again, as a remount within one commit does, so a call keeps one
 * element for its life.
 */
export function ViewElement({
  tag,
  view,
  toggleKey,
  onChosen,
}: {
  readonly tag: string;
  readonly view: ChatToolView | ChatInputView;
  /** The key the conversation's toggle key reaches this element by. */
  readonly toggleKey: string;
  readonly onChosen: (chosen: boolean) => void;
}): JSX.Element {
  const { ui } = useContext(ChatBlocksContext);
  const frame = useRef<HTMLDivElement>(null);
  const held = useRef<Held | null>(null);
  const latest = useRef({ view, onChosen });
  latest.current = { view, onChosen };

  useEffect(() => {
    const host = frame.current;
    if (host === null || ui === null) return;
    const kept = held.current;
    let current: Held;
    if (
      kept !== null &&
      kept.tag === tag &&
      kept.ui === ui &&
      kept.toggleKey === toggleKey
    ) {
      kept.released = false;
      current = kept;
    } else {
      let created: ViewHost;
      try {
        created = ui.create(tag, { view: latest.current.view }) as ViewHost;
      } catch (error) {
        console.error(
          `Doric: the element <${tag}> could not be created:`,
          error,
        );
        return;
      }
      current = { tag, ui, toggleKey, element: created, released: false };
      held.current = current;
    }
    const { element } = current;
    if (element.view !== latest.current.view)
      element.view = latest.current.view;
    hostedViews.set(toggleKey, element);
    if (host.firstChild !== (element as unknown as Node))
      host.replaceChildren(element as unknown as Node);
    return () => {
      current.released = true;
      queueMicrotask(() => {
        if (!current.released) return;
        if (held.current === current) held.current = null;
        if (hostedViews.get(toggleKey) === element)
          hostedViews.delete(toggleKey);
        (element as { remove?: () => void }).remove?.();
        try {
          ui.dispose(element);
        } catch {
          // An element already disposed needs nothing more.
        }
      });
    };
  }, [tag, ui, toggleKey]);

  useEffect(() => {
    const current = held.current;
    if (current !== null && current.element.view !== view)
      current.element.view = view;
  }, [view]);

  useEffect(() => {
    const host = frame.current;
    if (host === null) return;
    const listener = (event: Event): void => {
      // The choice is this block's: it goes no further than its frame.
      event.stopPropagation();
      const chosen = chosenOf(event);
      if (chosen !== undefined) latest.current.onChosen(chosen);
    };
    host.addEventListener(CHAT_BLOCK_CHOSEN_EVENT, listener);
    return () => host.removeEventListener(CHAT_BLOCK_CHOSEN_EVENT, listener);
  }, []);

  return <div ref={frame} />;
}
