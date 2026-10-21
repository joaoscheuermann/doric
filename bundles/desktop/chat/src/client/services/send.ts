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

import { defineMethod, defineService } from 'bundle/contracts';

import {
  type ChatSendInput,
  type ChatSendResult,
  ChatSendV1,
  type ComposerSnapshot,
  chatSendMethods,
} from '../../contracts/index.js';
import { composerFeed } from '../api/composer.js';
import { promptEnvelope } from '../domain/prompt-envelope.js';
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

/** `chat.send/v1` over the window's own send path. */
export const createChatSend = (
  dependencies: ChatSendDependencies = windowDependencies,
) =>
  defineService(ChatSendV1, {
    send: defineMethod({
      ...chatSendMethods.send,
      execute: (input: ChatSendInput) => sendStack(input, dependencies),
    }),
  });
