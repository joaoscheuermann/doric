// The `papercraft` desktop part: the `papercraft.open-canvas/v1` command, which
// opens or focuses the canvas window at `/papercraft/:artifactId`.
//
// The window is an app route (`windows/v1`, a path window), not a host `view`:
// the canvas is the same modules, services and import map as the node. The core
// already focuses an open key and navigates a window whose path differs, so a
// second call for the same preview focuses the window it opened first.

import { defineCommand, WindowsV1 } from 'bundle/contracts';
import { z } from 'zod';

import { canvasPathOf, OPEN_CANVAS_COMMAND } from '../contracts/index.js';

export const openCanvasInput = z
  .object({ artifactId: z.string().min(1) })
  .strict();

export type OpenCanvasInput = z.output<typeof openCanvasInput>;

/** The window appearance of the canvas: the app's integrated title bar. */
export const CANVAS_APPEARANCE = { titleBar: 'integrated' } as const;

export const openCanvas = defineCommand({
  id: OPEN_CANVAS_COMMAND,
  input: openCanvasInput,
  execute: async ({ artifactId }, call, services) => {
    await services.use(WindowsV1).open(
      {
        key: artifactId,
        path: canvasPathOf(artifactId),
        appearance: CANVAS_APPEARANCE,
      },
      call,
    );
  },
});
