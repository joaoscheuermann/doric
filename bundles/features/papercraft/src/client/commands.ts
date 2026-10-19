// The client commands of the command bar (spec: "A barra de comandos").
//
// Each control of the window's bar dispatches one of these by
// `commands/v1.execute`, and so does every `menus/v1` keybinding the client
// registers for the canvas route: the bar and the keyboard are one path, and
// the state they act on is view state of the canvas — the frame's, never a
// new one of the command's. The one durable action here is `Autorizar`, which
// writes `artifacts.approved/v1` under the `request` policy and then asks the
// canvas to read the record again, so its reading turns `Autorizado`.

import type { Call, Services } from 'bundle/contracts';
import { defineCommand } from 'bundle/contracts';
import { z } from 'zod';

import {
  APPROVE_COMMAND,
  ArtifactsV1,
  COMMENT_COMMAND,
  callScopeOf,
  ISOLATE_COMMAND,
  PAN_COMMAND,
  SELECT_COMMAND,
  SELECT_REVISION_COMMAND,
  SEND_COMMAND,
  SHOW_ALL_COMMAND,
  ZOOM_FIT_COMMAND,
  ZOOM_IN_COMMAND,
  ZOOM_OUT_COMMAND,
  ZOOM_RESET_COMMAND,
} from '../contracts/index.js';
import { controllerFor } from './canvas-registry.js';

/** Which canvas a command acts on: optional, else the last one touched. */
export const canvasCommandInput = z
  .object({
    artifactId: z.string().min(1).optional(),
    revision: z.number().int().positive().optional(),
  })
  .strict();

export type CanvasCommandInput = z.output<typeof canvasCommandInput>;

const of = (input: CanvasCommandInput) => controllerFor(input.artifactId);

/** The tool commands: the radio group of the bar. */
export const selectToolCommand = defineCommand({
  id: SELECT_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.setTool('select'),
});

export const commentToolCommand = defineCommand({
  id: COMMENT_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.setTool('comment'),
});

export const panToolCommand = defineCommand({
  id: PAN_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.setTool('pan'),
});

/** The selection commands. */
export const isolateCommand = defineCommand({
  id: ISOLATE_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.isolate(),
});

export const showAllCommand = defineCommand({
  id: SHOW_ALL_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.showAll(),
});

/** The viewport commands. */
export const zoomOutCommand = defineCommand({
  id: ZOOM_OUT_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.zoomOut(),
});

export const zoomResetCommand = defineCommand({
  id: ZOOM_RESET_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.zoomReset(),
});

export const zoomInCommand = defineCommand({
  id: ZOOM_IN_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.zoomIn(),
});

export const zoomFitCommand = defineCommand({
  id: ZOOM_FIT_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.zoomFit(),
});

/** The proposal commands: which revision is on screen, and the approval. */
export const selectRevisionCommand = defineCommand({
  id: SELECT_REVISION_COMMAND,
  input: canvasCommandInput,
  execute: (input) => {
    if (input.revision !== undefined) of(input)?.selectRevision(input.revision);
  },
});

/**
 * `papercraft.send/v1`: the canvas window's `CmdOrCtrl+Enter`, the chord's one
 * owner there — the open note is confirmed and the Thread's stack goes out
 * through chat's `chat.send/v1`, wherever the focus is in the window.
 */
export const sendCommand = defineCommand({
  id: SEND_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.sendNow(),
});

/**
 * `papercraft.approve/v1`: under the `request` policy, writes the approval of
 * the revision the canvas shows and refreshes it, so `Autorizar` becomes the
 * reading `Autorizado`. The window's bar owns the button; the node shows the
 * waiting as a reading only. The `CmdOrCtrl+Shift+Enter` keybinding dispatches it
 * with no input, so the canvas is the one named, else the one the reader last
 * touched — and the call carries that canvas's Project and Thread as its scope.
 */
export const approveCommand = defineCommand({
  id: APPROVE_COMMAND,
  input: canvasCommandInput,
  execute: async (
    input: CanvasCommandInput,
    call: Call,
    services: Services,
  ) => {
    const canvas = of(input);
    const artifactId = input.artifactId ?? canvas?.artifactId;
    const revision = input.revision ?? canvas?.currentRevision();
    const scope = canvas?.scope;

    if (artifactId === undefined || revision === undefined) return;
    if (scope === undefined) return;

    await services
      .use(ArtifactsV1, callScopeOf(scope))
      .approve({ artifactId, revision }, call);

    canvas?.reload();
  },
});

/** Every client command of the canvas, as the activation registers them. */
export const canvasCommands = [
  selectToolCommand,
  commentToolCommand,
  panToolCommand,
  isolateCommand,
  showAllCommand,
  zoomOutCommand,
  zoomResetCommand,
  zoomInCommand,
  zoomFitCommand,
  selectRevisionCommand,
  sendCommand,
] as const;
