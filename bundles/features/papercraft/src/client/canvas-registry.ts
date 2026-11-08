// The live canvases of this window, by artifact: what the command bar's
// commands act on (spec: "A barra de comandos").
//
// Every control of the bar dispatches by `commands/v1.execute`, the path the
// `git` Changes panel uses, and a command finds its canvas here — the one the
// input names, or the one the reader last touched. The registry is view state
// only: nothing durable ever consults it.

import type { PreviewScope, PreviewTool } from '../contracts/index.js';

/** What one mounted canvas frame lets a command do to it. */
export interface PreviewController {
  readonly canvasId: string;
  /** The Project and Thread the canvas belongs to: every host call's scope. */
  readonly scope: PreviewScope | undefined;
  /** The armed tool: `select` is the entry default. */
  setTool(tool: PreviewTool): void;
  /** Isolates the selected node: its chain stays, the siblings hide. */
  isolate(): void;
  /** Undoes isolation and every hidden layer. */
  showAll(): void;
  zoomOut(): void;
  zoomReset(): void;
  zoomIn(): void;
  /** `⤢`: fits the revision's content into the canvas. */
  zoomFit(): void;
  /** Switches the revision on screen. */
  selectRevision(revision: number): void;
  /** Which revision is on screen. */
  currentRevision(): number | undefined;
  /** Confirms the open note and sends the Thread's stack. */
  sendNow(): Promise<void>;
}

const canvases = new Map<string, PreviewController>();
let lastActive: string | undefined;

/** Registers one canvas; the release drops it and only it. */
export const registerController = (
  controller: PreviewController,
): (() => void) => {
  canvases.set(controller.canvasId, controller);
  lastActive = controller.canvasId;

  return () => {
    if (canvases.get(controller.canvasId) === controller)
      canvases.delete(controller.canvasId);

    if (lastActive === controller.canvasId) {
      lastActive = [...canvases.keys()].at(-1);
    }
  };
};

/** Marks one registered canvas as the one the reader touched last. */
export const touchController = (canvasId: string): void => {
  if (canvases.has(canvasId)) lastActive = canvasId;
};

/** The canvas a command acts on: the one named, else the last one touched. */
export const controllerFor = (
  canvasId?: string,
): PreviewController | undefined =>
  canvasId === undefined
    ? lastActive === undefined
      ? undefined
      : canvases.get(lastActive)
    : canvases.get(canvasId);

/** Which canvas the reader last touched. */
export const activeCanvasId = (): string | undefined => lastActive;
