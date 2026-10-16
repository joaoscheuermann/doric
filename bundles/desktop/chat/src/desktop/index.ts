// The `chat` bundle's desktopMain part: it provides `chat.composer/v1`, the
// composer's state in the main process — the draft text and the comment stack
// of every Thread, one state shared by every window (`docs/architecture/bundles/
// papercraft.md`, "Comentários acima do prompt, rascunho no host"). It also owns
// the `message` comment kind, the proof that a second consumer rides the same
// stack: the flush of that kind is registered here, in the environment the
// flush runs in, and any bundle that owns a kind registers its own flush the
// same way from its own desktop part.

import type { Cleanup, DesktopContext } from 'bundle/contracts';

import { composerService } from './composer-service.js';
import { createComposerState } from './composer-state.js';
import { MESSAGE_KIND, messageFlush } from './message-flush.js';

export function activate({ services }: DesktopContext): Cleanup {
  const state = createComposerState();
  // The chat owns the `message` kind, so it registers the flush of that kind
  // itself — the same `registerFlush` any other kind's owner calls from its
  // own desktop part. Deactivation drops the whole state with the service.
  const message = state.registerFlush(MESSAGE_KIND, messageFlush);

  services.provide(composerService(state));

  return () => {
    message.dispose();
  };
}

export {
  MESSAGE_KIND,
  messageFlush,
  messageTargetOf,
} from './message-flush.js';
