import { bootstrapWindow } from 'desktop-client';

import { legacyFlushListeners } from './legacy/flush';

void bootstrapWindow({
  mount: async ({ description }) =>
    (await import('./legacy/mount')).legacyMount(description),
  flushParticipants: legacyFlushListeners,
});
