// The `papercraft` client part (spec: "Composição e partes").
//
// It defines `<papercraft-preview>` (the `preview` kind's body, which the
// `artifacts` registry's frame mounts — the `artifacts` bundle projects the
// `artifacts.*` events into frames, so this part registers no projector),
// whose canvas opens as a modal over the conversation (a comment's stack line
// is chat's own); notes when `chat.composer/v1` is active (`whenAvailable`, as
// `threads` does), so the comment gesture joins its stack (the flush that
// answers the `comments/v1.add` writes is the desktop part's); and registers
// the commands of the command bar.

import {
  type Cleanup,
  type ClientContext,
  CommandsV1,
  UiV1,
} from 'bundle/contracts';

import { ChatComposerV1 } from '../contracts/chat.js';
import { PAPERCRAFT_PREVIEW_TAG } from '../contracts/index.js';
import { approveCommand, canvasCommands } from './commands.js';
import { setComposerAvailable } from './comment.js';
import { definePreviewElement, PAPERCRAFT_TAGS } from './elements.js';

/** Registers the element, the commands and the chat seam of the client. */
export function activate({ services }: ClientContext): Cleanup {
  const ui = services.use(UiV1);

  const previewElement = ui.define(
    PAPERCRAFT_PREVIEW_TAG,
    definePreviewElement(),
  );

  const commands = services.use(CommandsV1);
  const registered = [
    ...canvasCommands.map((command) => commands.register(command)),
    commands.register(approveCommand),
  ];

  // Chat's composer may not be active yet (or at all): the comment gesture
  // joins its stack whenever it is.
  const composer = services.whenAvailable(ChatComposerV1, () => {
    setComposerAvailable(true);

    return () => setComposerAvailable(false);
  });

  return () => {
    composer.dispose();
    for (const command of registered.reverse()) command.dispose();
    previewElement.dispose();
  };
}

export { ChatComposerV1 } from '../contracts/chat.js';
export { anchorOf, STAMP_ATTRIBUTE, selectorOf, targetOf } from './anchor.js';
export {
  type PreviewBlockData,
  previewBlockDataOf,
} from './block.js';
export {
  activeCanvasId,
  controllerFor,
  type PreviewController,
  registerController,
  touchController,
} from './canvas-registry.js';
export {
  approveCommand,
  canvasCommands,
} from './commands.js';
export {
  beginComment,
  composerAvailable,
  draftOfItem,
  locationScope,
  type PendingComment,
  type PendingCommentData,
  type PreviewDraft,
  resolveComment,
  setComposerAvailable,
} from './comment.js';
export {
  applyPreviewEvent,
  commentsOfEvents,
  initialPreviewStates,
  type PreviewComment,
  type PreviewState as PreviewEventState,
  type PreviewThread,
  previewStateOfRecord,
  type ThreadState,
  threadStateOf,
  threadsOf,
} from './domain/preview-state.js';
export { definePreviewElement } from './elements.js';
export { PAPERCRAFT_TAGS };
