// The `papercraft` client part (spec: "Composição e partes").
//
// It defines `<papercraft-preview>` (the `preview` kind's body, which the
// `artifacts` registry's frame mounts — the `artifacts` bundle projects the
// `artifacts.*` events into frames, so this part registers no projector),
// and `<papercraft-canvas>` (a comment's stack line is chat's own); notes when
// `chat.composer/v1` is active (`whenAvailable`, as `threads` does), so
// the comment gesture joins its stack (the flush that answers the
// `comments/v1.add` writes is the desktop part's); registers the canvas route
// (`/papercraft/:projectId/:threadId/:artifactId`); and registers the
// commands of the command bar plus their `menus/v1` keybindings, each pointing
// at the command id it dispatches, filtered to the canvas route.

import {
  type Cleanup,
  type ClientContext,
  CommandsV1,
  MenusV1,
  NavigationV1,
  type RouteRegistration,
  UiV1,
} from 'bundle/contracts';

import { ChatComposerV1 } from '../contracts/chat.js';
import {
  CANVAS_ROUTE,
  PAPERCRAFT_CANVAS_TAG,
  PAPERCRAFT_KEYBINDINGS,
  PAPERCRAFT_PREVIEW_TAG,
} from '../contracts/index.js';
import { approveCommand, canvasCommands } from './commands.js';
import { setComposerAvailable } from './comment.js';
import {
  defineCanvasElement,
  definePreviewElement,
  PAPERCRAFT_TAGS,
} from './elements.js';

/**
 * The canvas window's route. It stands alone, as `/settings` does: under the
 * workspace (`parent: '/'`) the layout would mount around the canvas, and its
 * restored Project and Thread selection would rewrite the window's path to
 * that Thread, dropping the canvas.
 */
export const canvasRouteOf = (
  create: (params: Readonly<Record<string, string>>) => object,
): RouteRegistration => ({
  path: CANVAS_ROUTE,
  create: (match) => create(match.params),
});

/** Registers every element, command, keybinding and chat seam of the client. */
export function activate({ services }: ClientContext): Cleanup {
  const ui = services.use(UiV1);

  const previewElement = ui.define(
    PAPERCRAFT_PREVIEW_TAG,
    definePreviewElement(),
  );
  const canvasElement = ui.define(PAPERCRAFT_CANVAS_TAG, defineCanvasElement());

  const route = services
    .use(NavigationV1)
    .register(
      canvasRouteOf((params) => ui.create(PAPERCRAFT_CANVAS_TAG, params)),
    );

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

  // Chat's composer may not be active yet (or at all): the comment gesture
  // joins its stack whenever it is.
  const composer = services.whenAvailable(ChatComposerV1, () => {
    setComposerAvailable(true);

    return () => setComposerAvailable(false);
  });

  return () => {
    composer.dispose();
    for (const command of registered.reverse()) command.dispose();
    route.dispose();
    canvasElement.dispose();
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
export { defineCanvasElement, definePreviewElement } from './elements.js';
export { PAPERCRAFT_TAGS };
