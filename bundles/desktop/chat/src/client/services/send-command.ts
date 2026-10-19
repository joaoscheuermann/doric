// `chat.send-prompt/v1`: the window's `CmdOrCtrl+Enter` on the conversation's
// route, bound through `menus/v1` so the chord has one owner wherever the
// focus is — the prompt, a stack note, a block another bundle draws in the
// transcript (a Papercraft canvas) or the window's chrome. No surface answers
// the chord itself any more; each new count of the composer's send request is
// the editor's own send, the one the footer's control makes, so the words, the
// stack, or both go out once, and a running prompt is steered.
//
// The Thread is the one whose conversation holds the focus (a side panel shows
// another Thread than the route), else the one the route names. Before the
// send reads the stack, `doric:prompt-send` lets a surface confirm a note the
// reader has not confirmed yet, and the stack is read back from the service so
// the note just added goes with the prompt.

import { defineCommand, type Navigation, NavigationV1 } from 'bundle/contracts';
import { z } from 'zod';

import {
  PROMPT_SEND_EVENT,
  type PromptSendDetail,
  SEND_PROMPT_COMMAND,
} from '../../contracts/index.js';
import { THREAD_ROUTE } from '../domain/thread-route.js';
import { composerFor } from '../stores/composer.js';
import { composerStackStore } from '../stores/composer-stack.js';

/** The attribute every conversation's root carries: its Thread's id. */
const THREAD_ATTRIBUTE = 'data-chat-thread';

/** The innermost focused element, through every open shadow root. */
const deepFocus = (document: Document): Element | null => {
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement)
    focused = focused.shadowRoot.activeElement;
  return focused;
};

/** The Thread of the conversation holding the focus, across shadow roots. */
const focusedThread = (document: Document): string | undefined => {
  for (
    let node: Node | null = deepFocus(document);
    node !== null;
    node = node instanceof ShadowRoot ? node.host : node.parentNode
  ) {
    if (node instanceof Element) {
      const threadId = node.getAttribute(THREAD_ATTRIBUTE);
      if (threadId !== null && threadId !== '') return threadId;
    }
  }
  return undefined;
};

/** The Thread the route names, when the route is the conversation's. */
const routeThread = (navigation: Navigation): string | undefined => {
  const match = navigation.current();
  return match?.pattern === THREAD_ROUTE ? match.params.threadId : undefined;
};

/** Lets the surfaces settle what the send should carry; see the module comment. */
const settleBeforeSend = async (
  document: Document,
  threadId: string,
): Promise<void> => {
  const pending: Promise<unknown>[] = [];
  const detail: PromptSendDetail = {
    threadId,
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  document.dispatchEvent(new CustomEvent(PROMPT_SEND_EVENT, { detail }));
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
  await composerStackStore.getState().sync(threadId);
};

export const sendPromptCommand = defineCommand({
  id: SEND_PROMPT_COMMAND,
  input: z.object({}).strict(),
  execute: async (_input, _call, services) => {
    const threadId =
      focusedThread(document) ?? routeThread(services.use(NavigationV1));
    if (threadId === undefined) return;
    await settleBeforeSend(document, threadId);
    composerFor(threadId).getState().send();
  },
});
