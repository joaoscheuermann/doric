// The `papercraft` desktopMain part: provides `papercraft.snapshot/v1` (a
// window's capture of its own pixels) and registers the flush of the
// `papercraft-preview` comment kind.
//
// The flush is registered here because `chat.composer/v1.registerFlush` carries
// a function and only serves the main process: when the send of a prompt drains
// the stack, the composer service calls this flush, and it answers the durable
// `comments/v1.add` writes the sender window then performs — chat never learns
// what a preview comment is. The composer is chat's and optional: the flush is
// registered whenever it is active, and a composition without chat still opens
// the canvas modal.

import type { Cleanup, DesktopContext } from 'bundle/contracts';

import { ChatComposerV1 } from '../contracts/chat.js';
import { PAPERCRAFT_COMMENT_KIND } from '../contracts/index.js';
import { papercraftFlush } from './comment-flush.js';
import { snapshotService } from './snapshot.js';

export const activate = ({ services }: DesktopContext): Cleanup => {
  const snapshot = services.provide(snapshotService());

  const flush = services.whenAvailable(ChatComposerV1, (composer) => {
    const registration = composer.registerFlush({
      kind: PAPERCRAFT_COMMENT_KIND,
      flush: papercraftFlush,
    });

    return () => registration.dispose();
  });

  return () => {
    flush.dispose();
    snapshot.dispose();
  };
};

export { papercraftFlush } from './comment-flush.js';
export {
  platformCapture,
  snapshotService,
  type WindowCapture,
} from './snapshot.js';
