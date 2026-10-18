// `chat.composer/v1` (desktopMain), the service the state machine wears: the
// `expose: 'desktop'` methods a window reaches over the bridge and the one it
// cannot (`registerFlush` carries a function, so only callers in the main
// process reach it). The key the state is held under is the call's
// `projectId` scope and the Thread the input names — the `(projectId,
// threadId)` pair the docs key the composer's state by.

import {
  type Call,
  defineMethod,
  defineService,
  toStreamObserver,
} from 'bundle/contracts';

import { ChatComposerV1, chatComposerMethods } from '../contracts/index.js';
import type { ComposerState } from './composer-state.js';

/** The `projectId` a call's scope names, when it names one. */
const projectOf = (call: Call | undefined): string | undefined => {
  const scope = call?.scope as { projectId?: unknown } | undefined;

  return typeof scope?.projectId === 'string' ? scope.projectId : undefined;
};

/** Builds `chat.composer/v1` over the state machine. */
export const composerService = (state: ComposerState) =>
  defineService(ChatComposerV1, {
    read: defineMethod({
      expose: chatComposerMethods.read.expose,
      input: chatComposerMethods.read.input,
      output: chatComposerMethods.read.output,
      execute: (input, call: Call) =>
        Promise.resolve(state.read(projectOf(call), input.threadId)),
    }),

    watch: defineMethod({
      expose: chatComposerMethods.watch.expose,
      input: chatComposerMethods.watch.input,
      output: chatComposerMethods.watch.output,
      execute: ([threadId, listener], call: Call) =>
        state.watch(projectOf(call), threadId, (item) => {
          toStreamObserver(listener).next(item);
        }),
    }),

    setText: defineMethod({
      expose: chatComposerMethods.setText.expose,
      input: chatComposerMethods.setText.input,
      output: chatComposerMethods.setText.output,
      execute: (input, call: Call) => {
        state.setText(projectOf(call), input.threadId, input.text);
        return Promise.resolve();
      },
    }),

    addItem: defineMethod({
      expose: chatComposerMethods.addItem.expose,
      input: chatComposerMethods.addItem.input,
      output: chatComposerMethods.addItem.output,
      execute: (input, call: Call) =>
        Promise.resolve(state.addItem(projectOf(call), input)),
    }),

    updateNote: defineMethod({
      expose: chatComposerMethods.updateNote.expose,
      input: chatComposerMethods.updateNote.input,
      output: chatComposerMethods.updateNote.output,
      execute: (input, call: Call) => {
        state.updateNote(projectOf(call), input.threadId, input.id, input.note);
        return Promise.resolve();
      },
    }),

    removeItem: defineMethod({
      expose: chatComposerMethods.removeItem.expose,
      input: chatComposerMethods.removeItem.input,
      output: chatComposerMethods.removeItem.output,
      execute: (input, call: Call) => {
        state.removeItem(projectOf(call), input.threadId, input.id);
        return Promise.resolve();
      },
    }),

    flush: defineMethod({
      expose: chatComposerMethods.flush.expose,
      input: chatComposerMethods.flush.input,
      output: chatComposerMethods.flush.output,
      execute: (input, call: Call) =>
        state.flush({
          projectId: projectOf(call),
          threadId: input.threadId,
          promptId: input.promptId,
        }),
    }),

    registerFlush: defineMethod({
      input: chatComposerMethods.registerFlush.input,
      output: chatComposerMethods.registerFlush.output,
      execute: (input) => state.registerFlush(input.kind, input.flush),
    }),
  });
