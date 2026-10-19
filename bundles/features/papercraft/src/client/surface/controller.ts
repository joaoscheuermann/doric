// `controller.ts` — what the command bar's commands (and the node's footer)
// do to one frame: the armed tool, isolation, the viewport and the revision
// on screen. One stable controller per frame, registered with the window's
// canvas registry while the frame is the canvas window; and how the frame
// dispatches a command itself (`commands/v1.execute`, the path the bar's
// controls and the node's `abrir` take).

import { type Commands, CommandsV1, type Services } from 'bundle/contracts';
import { type RefObject, useCallback, useEffect, useMemo } from 'react';

import {
  OPEN_CANVAS_COMMAND,
  type PreviewTool,
} from '../../contracts/index.js';
import {
  type PreviewController,
  registerController,
} from '../canvas-registry.js';
import type { Scene } from './scene.js';
import { isolateHiddenIds } from './scene-graph.js';
import { IDENTITY, type Viewport, ZOOM_STEP, zoomAt } from './viewport.js';

/** What the controller reads of the latest render when a command runs. */
export interface FrameReading {
  readonly scene: Scene | undefined;
  readonly selectedId: string | undefined;
  readonly revision: number | undefined;
}

export interface ControllerInput {
  readonly chrome: 'node' | 'canvas';
  readonly artifactId: string;
  readonly scopeProject: string | undefined;
  readonly scopeThread: string | undefined;
  readonly latest: RefObject<FrameReading>;
  readonly setTool: (tool: PreviewTool) => void;
  readonly setHidden: (hidden: ReadonlySet<string>) => void;
  readonly setViewport: (update: (current: Viewport) => Viewport) => void;
  readonly setSelectedId: (id: string | undefined) => void;
  readonly areaSize: () => { readonly width: number; readonly height: number };
  readonly fitContent: () => boolean;
  readonly selectRevision: (revision: number) => void;
  readonly reload: () => void;
  readonly sendNow: () => Promise<void>;
}

export const usePreviewController = ({
  chrome,
  artifactId,
  scopeProject,
  scopeThread,
  latest,
  setTool,
  setHidden,
  setViewport,
  setSelectedId,
  areaSize,
  fitContent,
  selectRevision,
  reload,
  sendNow,
}: ControllerInput): PreviewController => {
  const controller = useMemo<PreviewController>(() => {
    /** One zoom step about the surface centre. */
    const step = (factor: number) => {
      const area = areaSize();

      setViewport((current) =>
        zoomAt(
          current,
          factor,
          area.width > 0
            ? { x: area.width / 2, y: area.height / 2 }
            : { x: 0, y: 0 },
        ),
      );
    };

    return {
      artifactId,
      scope:
        scopeProject === undefined
          ? undefined
          : {
              projectId: scopeProject,
              ...(scopeThread === undefined ? {} : { threadId: scopeThread }),
            },
      setTool: (next) => setTool(next),
      isolate: () => {
        const { scene, selectedId } = latest.current;

        if (scene === undefined || selectedId === undefined) return;

        setHidden(isolateHiddenIds(scene.graph, selectedId));
      },
      showAll: () => setHidden(new Set()),
      zoomOut: () => step(1 / ZOOM_STEP),
      zoomReset: () => setViewport(() => IDENTITY),
      zoomIn: () => step(ZOOM_STEP),
      zoomFit: () => {
        fitContent();
      },
      selectRevision: (revision) => {
        setSelectedId(undefined);
        setHidden(new Set());
        selectRevision(revision);
      },
      currentRevision: () => latest.current.revision ?? undefined,
      reload,
      sendNow,
    };
  }, [
    artifactId,
    scopeProject,
    scopeThread,
    latest,
    setTool,
    setHidden,
    setViewport,
    setSelectedId,
    areaSize,
    fitContent,
    selectRevision,
    reload,
    sendNow,
  ]);

  useEffect(() => {
    if (chrome !== 'canvas') return;

    return registerController(controller);
  }, [chrome, controller]);

  return controller;
};

/** How the frame dispatches a command, and the node's `abrir`: the canvas window. */
export const useCommandDispatch = (
  services: Services,
  artifactId: string,
  scopeProject: string | undefined,
  scopeThread: string | undefined,
): {
  readonly execute: (
    command: Parameters<Commands['execute']>[0],
    input?: unknown,
  ) => void;
  readonly openCanvas: () => void;
} => {
  const execute = useCallback(
    (command: Parameters<Commands['execute']>[0], input?: unknown) => {
      void services
        .use(CommandsV1)
        .execute(command, input)
        .catch(() => undefined);
    },
    [services],
  );

  const openCanvas = useCallback(() => {
    if (scopeProject === undefined || scopeThread === undefined) return;

    execute(OPEN_CANVAS_COMMAND, {
      artifactId,
      projectId: scopeProject,
      threadId: scopeThread,
    });
  }, [execute, artifactId, scopeProject, scopeThread]);

  return { execute, openCanvas };
};
