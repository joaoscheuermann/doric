// The `papercraft` desktop part: the `papercraft.open-canvas/v2` command, which
// opens or focuses the canvas window at
// `/papercraft/:projectId/:threadId/:identity` — the conversation the
// program belongs to rides in the path, so the window's calls are scoped to
// its Project and its comments join that Thread's composer stack.
//
// The window is an app route (`windows/v1`, a path window), not a host `view`:
// the canvas is the same modules, services and import map as the node. The core
// already focuses an open key and navigates a window whose path differs, so a
// second call for the same program focuses the window it opened first.

import { defineCommand, WindowsV1 } from 'bundle/contracts';
import { z } from 'zod';

import { canvasIdOf } from '../client/surface/canvas-source.js';
import { canvasPathOf, OPEN_CANVAS_COMMAND } from '../contracts/index.js';

/**
 * `papercraft.open-canvas/v2@2.0.0`'s input (D26): the Project, the Thread and
 * the papercraft program's `identity`. Strict: a missing or an unknown field
 * (an old `artifactId`) fails with `invalid_input`.
 */
export const openCanvasInput = z
  .object({
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    identity: z.string().min(1),
  })
  .strict();

export type OpenCanvasInput = z.output<typeof openCanvasInput>;

/** The window appearance of the canvas: the app's integrated title bar. */
export const CANVAS_APPEARANCE = { titleBar: 'integrated' } as const;

export const openCanvas = defineCommand({
  id: OPEN_CANVAS_COMMAND,
  input: openCanvasInput,
  execute: async (input, call, services) => {
    const { projectId, threadId, identity } = input;

    await services.use(WindowsV1).open(
      {
        key: canvasIdOf({ kind: 'program', threadId, identity }),
        path: canvasPathOf({ projectId, threadId, segment: identity }),
        appearance: CANVAS_APPEARANCE,
      },
      call,
    );
  },
});
