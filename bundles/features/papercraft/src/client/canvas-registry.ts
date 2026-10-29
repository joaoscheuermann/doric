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
  readonly artifactId: string;
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
  /** Which revision is on screen, as `Autorizar` needs it. */
  currentRevision(): number | undefined;
  /** Rereads the record after its approval changed it. */
  reload(): void;
  /** Confirms the open note and sends the Thread's stack. */
  sendNow(): Promise<void>;
}

const canvases = new Map<string, PreviewController>();
let lastActive: string | undefined;

/** Registers one canvas; the release drops it and only it. */
export const registerController = (
  controller: PreviewController,
): (() => void) => {
  canvases.set(controller.artifactId, controller);
  lastActive = controller.artifactId;

  return () => {
    if (canvases.get(controller.artifactId) === controller)
      canvases.delete(controller.artifactId);

    if (lastActive === controller.artifactId) {
      lastActive = [...canvases.keys()].at(-1);
    }
  };
};

/** Marks one registered canvas as the one the reader touched last. */
export const touchController = (artifactId: string): void => {
  if (canvases.has(artifactId)) lastActive = artifactId;
};

/** The canvas a command acts on: the one named, else the last one touched. */
export const controllerFor = (
  artifactId?: string,
): PreviewController | undefined =>
  artifactId === undefined
    ? lastActive === undefined
      ? undefined
      : canvases.get(lastActive)
    : canvases.get(artifactId);

/** Which canvas the reader last touched. */
export const activeCanvasId = (): string | undefined => lastActive;

/** Whether a canvas of `artifactId` is registered in this window — in the conversation's window, its node's modal is open. */
export const canvasOpen = (artifactId: string): boolean =>
  canvases.has(artifactId);
