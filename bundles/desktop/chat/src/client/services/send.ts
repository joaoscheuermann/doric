// `chat.send/v1`: the composer's send, for a surface outside the composer.
//
// It is the send the composer's control makes — `promptEnvelope` composes
// the prompt, the window's `threadChatsStore.prompt` asks the host and, only
// once the host accepted, flushes the stack into the log (an item whose write
// fails goes back on the stack). The draft is read from `chat.composer/v1`,
// the host-held draft every window shares — the stack and the draft text the
// editor last settled — so the send works from any window, whether or not it
// shows the conversation. Once the host accepted, the draft text is cleared,
// and every window's editor empties with it; a refused send leaves the text
// and the stack where they were.
//
// From 1.1.0, `sendAction` (conversation-openui.md D20) sends one click on a
// UI the agent drew, in a `<ui-action>` envelope, by the composer's route
// (`routeSend`), straight to the host's Thread API: it never touches the
// composer, the store's pending turn or its `sending` flag.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  type ChatActionInput,
  type ChatActionResult,
  type ChatSendInput,
  type ChatSendResult,
  ChatSendV1,
  type ComposerSnapshot,
  chatSendMethods,
} from '../../contracts/index.js';
import { composerFeed } from '../api/composer.js';
import { type ChatThreadsApi, threadsApi } from '../api/threads-api.js';
import { promptEnvelope, uiActionEnvelope } from '../domain/prompt-envelope.js';
import { queueItems } from '../domain/queue.js';
import { routeSend } from '../domain/send-route.js';
import { composerStackStore } from '../stores/composer-stack.js';
import { threadChatsStore } from '../stores/thread-chats.js';

/** One Thread, as the composer's draft is keyed. */
type DraftThread = { readonly id: string; readonly projectId: string };

/** What the send reads and asks with; the window's own by default. */
export interface ChatSendDependencies {
  readonly read: (thread: DraftThread) => Promise<ComposerSnapshot | undefined>;
  readonly prompt: (
    id: string,
    text: string,
    options: { readonly projectId: string },
  ) => Promise<boolean>;
  /** Writes the Thread's draft text; every window's editor follows it. */
  readonly setText: (thread: DraftThread, text: string) => void;
  /** The host's Thread API, which `sendAction` sends through (D20); the window's by default. */
  readonly threads?: Pick<
    ChatThreadsApi,
    'get' | 'steer' | 'queue' | 'resumeQueue' | 'prompt'
  >;
}

const windowDependencies: ChatSendDependencies = {
  // A note edit this window still holds reaches the service before the read.
  read: (thread) => {
    composerStackStore.getState().flushNotes(thread.id);
    return composerFeed.read(thread);
  },
  prompt: (id, text, options) =>
    threadChatsStore.getState().prompt(id, text, options),
  setText: (thread, text) => composerFeed.setText(thread, text),
};

/** Sends a Thread's held draft as its own prompt; see the module comment. */
export const sendStack = async (
  input: ChatSendInput,
  dependencies: ChatSendDependencies = windowDependencies,
): Promise<ChatSendResult> => {
  const thread = { id: input.threadId, projectId: input.projectId };
  const snapshot = await dependencies.read(thread);
  const words = snapshot?.text ?? '';
  const prompt = promptEnvelope(words, snapshot?.items ?? []);

  if (prompt.length === 0) return { status: 'empty' };

  const accepted = await dependencies.prompt(input.threadId, prompt, {
    projectId: input.projectId,
  });
  if (!accepted) return { status: 'refused' };

  // The words went out with the prompt, so the draft lets go of them.
  if (words.trim().length > 0) dependencies.setText(thread, '');

  return { status: 'accepted' };
};

/**
 * Sends one action of a UI the agent drew as the reader's next message: a
 * Thread that is missing, of another Project or an agent's is refused before
 * any other call; otherwise the composer's route takes the envelope.
 */
export const sendUiAction = async (
  input: ChatActionInput,
  dependencies: Pick<ChatSendDependencies, 'threads'> = windowDependencies,
): Promise<ChatActionResult> => {
  const threads = dependencies.threads ?? threadsApi;
  const { threadId } = input;
  const thread = await threads.get(threadId).catch(() => undefined);
  if (
    thread === undefined ||
    thread.projectId !== input.projectId ||
    thread.origin === 'agent'
  )
    return { status: 'refused' };

  const envelope = uiActionEnvelope(input.text, input.program);
  const taken = await routeSend(thread.activePromptId, {
    steer: async (promptId) => {
      await threads.steer(threadId, envelope, { promptId });
      return true;
    },
    queue: async () => {
      const queue = await threads.queue(threadId);
      return { paused: queue.paused, empty: queueItems(queue).length === 0 };
    },
    resumeQueue: async () => {
      await threads.resumeQueue(threadId);
      return true;
    },
    prompt: async () => {
      await threads.prompt(threadId, envelope);
      return true;
    },
  });
  return { status: taken ? 'accepted' : 'refused' };
};

/** `chat.send/v1` over the window's own send path. */
export const createChatSend = (
  dependencies: ChatSendDependencies = windowDependencies,
) =>
  defineService(ChatSendV1, {
    send: defineMethod({
      ...chatSendMethods.send,
      execute: (input: ChatSendInput) => sendStack(input, dependencies),
    }),
    sendAction: defineMethod({
      ...chatSendMethods.sendAction,
      execute: (input: ChatActionInput) => sendUiAction(input, dependencies),
    }),
  });
