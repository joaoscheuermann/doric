// `papercraft.cwd/v1@1.0.0` (D10): the Thread's working directory, appended
// by papercraft's host at a prompt's start and at a move during a prompt. A
// papercraft fence binds to the `cwd` of the last such event whose `sequence`
// is below the fence's `turnSequence`; without one its library is `none`.

import { defineEvent } from 'bundle/contracts';
import { z } from 'zod';

/** The event; its payload is the working directory as the runtime hooks give it. */
export const cwdEvent = defineEvent({
  type: 'papercraft.cwd/v1',
  payload: z.object({ cwd: z.string().min(1) }).strict(),
});
