// The `papercraft` desktopMain part: registers `papercraft.open-canvas/v1` and
// the flush of the `papercraft-preview` comment kind.
//
// The flush is registered here because `chat.composer/v1.registerFlush` carries
// a function and only serves the main process: when the send of a prompt drains
// the stack, the composer service calls this flush, and it answers the durable
// `comments/v1.add` writes the sender window then performs — chat never learns
// what a preview comment is. The composer is chat's and optional: the flush is
// registered whenever it is active, and a composition without chat still opens
// the canvas.

import {
  type Cleanup,
  CommandsV1,
  type DesktopContext,
} from 'bundle/contracts';

import { ChatComposerV1 } from '../contracts/chat.js';
import { PAPERCRAFT_COMMENT_KIND } from '../contracts/index.js';
import { openCanvas } from './commands.js';
import { papercraftFlush } from './comment-flush.js';

export const activate = ({ services }: DesktopContext): Cleanup => {
  const command = services.use(CommandsV1).register(openCanvas);

  const flush = services.whenAvailable(ChatComposerV1, (composer) => {
    const registration = composer.registerFlush({
      kind: PAPERCRAFT_COMMENT_KIND,
      flush: papercraftFlush,
    });

    return () => registration.dispose();
  });

  return () => {
    flush.dispose();
    command.dispose();
  };
};

export { openCanvas, openCanvasInput } from './commands.js';
export { papercraftFlush } from './comment-flush.js';
