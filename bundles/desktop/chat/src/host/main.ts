// src/host/main.ts — `chat`'s host part as a process (phase 3, S58): `chat.composer/v1` and the `message` kind's
// `ComposerFlushHandlerService`. The window keeps the desktopMain composer until phase 5.
import { runBundle } from 'bundle/host';

import {
  ComposerFlushHandlerService,
  ComposerService,
} from '../contracts/gen/doric/chat/composer/v1/composer_pb.js';
import { createChatHost } from './service.js';

const host = createChatHost();

runBundle({
  services: [
    [ComposerService, host.composer],
    [ComposerFlushHandlerService, host.flushHandler],
  ],
  activate: host.activate,
  deactivate: host.deactivate,
});
