// The `papercraft` desktop part: the `papercraft.open-canvas/v1` command, which
// opens or focuses the canvas window at
// `/papercraft/:projectId/:threadId/:artifactId` — the conversation the
// preview belongs to rides in the path, so the window's calls are scoped to
// its Project and its comments join that Thread's composer stack.
//
// The window is an app route (`windows/v1`, a path window), not a host `view`:
// the canvas is the same modules, services and import map as the node. The core
// already focuses an open key and navigates a window whose path differs, so a
// second call for the same preview focuses the window it opened first.

import { defineCommand, WindowsV1 } from 'bundle/contracts';
import { z } from 'zod';

import { canvasIdOf } from '../client/surface/canvas-source.js';
import { canvasPathOf, OPEN_CANVAS_COMMAND } from '../contracts/index.js';

const canvasScope = {
  projectId: z.string().min(1),
  threadId: z.string().min(1),
};

/**
 * `papercraft.open-canvas/v1@1.1.0`'s input: the Project, the Thread and
 * exactly one of `artifactId` (the old path, every 1.0.0 input) and
 * `identity` (a papercraft program, D26). Strict: both, neither or an unknown
 * field fail with `invalid_input`.
 */
export const openCanvasInput = z.union([
  z.object({ ...canvasScope, artifactId: z.string().min(1) }).strict(),
  z.object({ ...canvasScope, identity: z.string().min(1) }).strict(),
]);

export type OpenCanvasInput = z.output<typeof openCanvasInput>;

/** The window appearance of the canvas: the app's integrated title bar. */
export const CANVAS_APPEARANCE = { titleBar: 'integrated' } as const;

export const openCanvas = defineCommand({
  id: OPEN_CANVAS_COMMAND,
  input: openCanvasInput,
  execute: async (input, call, services) => {
    const { projectId, threadId } = input;
    const source =
      'artifactId' in input
        ? { kind: 'artifact' as const, artifactId: input.artifactId }
        : { kind: 'program' as const, threadId, identity: input.identity };
    const segment = 'artifactId' in input ? input.artifactId : input.identity;

    await services.use(WindowsV1).open(
      {
        key: canvasIdOf(source),
        path: canvasPathOf({ projectId, threadId, segment }),
        appearance: CANVAS_APPEARANCE,
      },
      call,
    );
  },
});
