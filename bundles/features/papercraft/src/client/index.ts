// The `papercraft` client part (spec: "Composição e partes").
//
// It defines `<papercraft-preview>`, `<papercraft-canvas>` and
// `<papercraft-comment-card>`; registers the chat projector and renderer for
// `papercraft.preview/v1` through `chat.views/v1` (`whenAvailable`, as
// `threads` does); binds `chat.composer/v1` the same way, and with it the
// flush that writes `comments/v1.add` when the send of a prompt drains the
// stack; registers the `/papercraft/:artifactId` route; and registers the
// commands of the command bar plus their `menus/v1` keybindings, each pointing
// at the command id it dispatches, filtered to the canvas route.

import {
  type Cleanup,
  type ClientContext,
  CommandsV1,
  MenusV1,
  NavigationV1,
  UiV1,
} from 'bundle/contracts';

import {
  CANVAS_ROUTE,
  PAPERCRAFT_CANVAS_TAG,
  PAPERCRAFT_COMMENT_CARD_TAG,
  PAPERCRAFT_KEYBINDINGS,
  PAPERCRAFT_PREVIEW_TAG,
  PREVIEW_BLOCK_TYPE,
} from '../contracts/index.js';
import { ChatComposerV1, ChatViewsV1 } from './chat-contract.js';
import { approveCommand, canvasCommands } from './commands.js';
import { setComposer } from './comment.js';
import {
  defineCanvasElement,
  defineCommentCardElement,
  definePreviewElement,
  PAPERCRAFT_TAGS,
} from './elements.js';
import { createPreviewProjector } from './projector.js';

/** Registers every element, command, keybinding and chat seam of the client. */
export function activate({ services }: ClientContext): Cleanup {
  const ui = services.use(UiV1);

  const previewElement = ui.define(
    PAPERCRAFT_PREVIEW_TAG,
    definePreviewElement(),
  );
  const canvasElement = ui.define(PAPERCRAFT_CANVAS_TAG, defineCanvasElement());
  const commentCard = ui.define(
    PAPERCRAFT_COMMENT_CARD_TAG,
    defineCommentCardElement(),
  );

  const route = services.use(NavigationV1).register({
    path: CANVAS_ROUTE,
    parent: '/',
    create: (match) => ui.create(PAPERCRAFT_CANVAS_TAG, match.params),
  });

  const commands = services.use(CommandsV1);
  const registered = [
    ...canvasCommands.map((command) => commands.register(command)),
    commands.register(approveCommand),
  ];

  // The shortcuts of the bar: owner = this bundle, each pointing at its
  // command id, filtered to the canvas route (`menus/v1.addKeybinding`, as the
  // core registers its own). The keys without a modifier are this window's
  // alone — the canvas window has no text field.
  const menus = services.use(MenusV1);
  for (const { command, key } of PAPERCRAFT_KEYBINDINGS) {
    void menus.addKeybinding({
      command,
      key,
      when: { path: CANVAS_ROUTE },
    });
  }

  // The chat may not be active yet (or at all, in a composition without it),
  // so the projection, the renderer and the composer seam are bound whenever
  // it appears.
  const views = services.whenAvailable(ChatViewsV1, (chat) => {
    const projector = chat.registerProjector(createPreviewProjector());
    const renderer = chat.registerRenderer({
      blockType: PREVIEW_BLOCK_TYPE,
      elementTag: PAPERCRAFT_PREVIEW_TAG,
    });

    return () => {
      renderer.dispose();
      projector.dispose();
    };
  });

  const composer = services.whenAvailable(ChatComposerV1, (api) => {
    setComposer(api);

    return () => setComposer(undefined);
  });

  return () => {
    composer.dispose();
    views.dispose();
    for (const command of registered.reverse()) command.dispose();
    route.dispose();
    commentCard.dispose();
    canvasElement.dispose();
    previewElement.dispose();
  };
}

export { anchorOf, STAMP_ATTRIBUTE, selectorOf, targetOf } from './anchor.js';
export {
  activeCanvasId,
  controllerFor,
  type PreviewController,
  registerController,
} from './canvas-registry.js';
export { ChatComposerV1, ChatViewsV1 } from './chat-contract.js';
export {
  approveCommand,
  canvasCommands,
} from './commands.js';
export {
  addComment,
  beginComment,
  COMMENT_INTENT_EVENT,
  dispatchCommentIntent,
  type PendingComment,
  type PendingCommentData,
  setComposer,
  threadIdOfLocation,
} from './comment.js';
export {
  applyPreviewEvent,
  commentsOfEvents,
  initialPreviewStates,
  type PreviewState as PreviewEventState,
  previewStateOfRecord,
} from './domain/preview-state.js';
export {
  defineCanvasElement,
  defineCommentCardElement,
  definePreviewElement,
} from './elements.js';
export {
  createPreviewProjector,
  previewBlockDataOf,
} from './projector.js';
export { PAPERCRAFT_TAGS };
