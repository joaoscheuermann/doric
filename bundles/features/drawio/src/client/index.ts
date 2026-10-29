// The `drawio` client part: defines `<drawio-diagram>` (the `diagram` kind's
// body, which the `artifacts` registry's frame mounts) and notes when
// `chat.composer/v1` is active, so the comment gesture joins its stack (the
// flush is the desktop part's).

import { type Cleanup, type ClientContext, UiV1 } from 'bundle/contracts';

import { ChatComposerV1 } from '../contracts/chat.js';
import { DIAGRAM_BODY_TAG } from '../contracts/index.js';
import { setComposerAvailable } from './comment.js';
import { defineDiagramElement } from './elements.js';

/**
 * Registers the element and the chat seam: `ui/v1.define(DIAGRAM_BODY_TAG,
 * defineDiagramElement())`, then `services.whenAvailable(ChatComposerV1, …)`
 * whose bind calls `setComposerAvailable(true)` and whose release calls
 * `setComposerAvailable(false)`. The cleanup disposes both, in reverse order
 * (the composer watch, then the element). Throws only what `ui/v1` throws.
 */
export function activate({ services }: ClientContext): Cleanup {
  const element = services
    .use(UiV1)
    .define(DIAGRAM_BODY_TAG, defineDiagramElement());
  const composer = services.whenAvailable(ChatComposerV1, () => {
    setComposerAvailable(true);

    return () => setComposerAvailable(false);
  });

  return () => {
    composer.dispose();
    element.dispose();
  };
}

export {
  composerAvailable,
  draftOfItem,
  drawioCommentStore,
  setComposerAvailable,
} from './comment.js';
export {
  type DiagramBlockData,
  type DiagramElement,
  defineDiagramElement,
  diagramBlockDataOf,
} from './elements.js';
export { ChatComposerV1 };
