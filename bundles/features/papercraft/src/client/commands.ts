// The client commands of the command bar (spec: "A barra de comandos").
//
// Each control of the modal's bar dispatches one of these by
// `commands/v1.execute`, and so does every key the modal maps through
// `keyCommandOf`: the bar and the keyboard are one path, and
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
  PAPERCRAFT_KEYBINDINGS,
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
 * `papercraft.send/v1`: the canvas header's send — the open note is confirmed
 * and the Thread's stack goes out through chat's `chat.send/v1`. No key chord
 * binds it: its `CmdOrCtrl+Enter` entry in PAPERCRAFT_KEYBINDINGS labels the
 * action, and in the modal that chord stays chat's own send.
 */
export const sendCommand = defineCommand({
  id: SEND_COMMAND,
  input: canvasCommandInput,
  execute: async (input) => of(input)?.sendNow(),
});

/**
 * `papercraft.approve/v1`: under the `request` policy, writes the approval of
 * the revision the canvas shows and refreshes it, so `Autorizar` becomes the
 * reading `Autorizado`. The modal's bar owns the button; the node shows the
 * waiting as a reading only. The `CmdOrCtrl+Shift+Enter` chord dispatches it
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

/* The modal's keys --------------------------------------------------------- */

/** What `keyCommandOf` reads of a key event. */
export interface KeyChord {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
}

type ModalCommand = Exclude<
  (typeof PAPERCRAFT_KEYBINDINGS)[number]['command'],
  typeof SEND_COMMAND
>;

/** One binding's chord, parsed once: its modifiers and its key. */
interface ParsedBinding {
  readonly command: ModalCommand;
  readonly cmdOrCtrl: boolean;
  readonly shift: boolean;
  readonly key: string;
}

const isModalCommand = (
  command: (typeof PAPERCRAFT_KEYBINDINGS)[number]['command'],
): command is ModalCommand => command !== SEND_COMMAND;

const modalBindings: readonly ParsedBinding[] = PAPERCRAFT_KEYBINDINGS.flatMap(
  ({ command, key }) => {
    if (!isModalCommand(command)) return [];

    // The key is the last part, so `CmdOrCtrl+-` keeps its `-`.
    const parts = key.split('+');
    const base = parts.at(-1) ?? '';
    const modifiers = parts.slice(0, -1);

    return [
      {
        command,
        cmdOrCtrl: modifiers.includes('CmdOrCtrl'),
        shift: modifiers.includes('Shift'),
        key: base,
      },
    ];
  },
);

/** Whether the chord's key is the binding's: a digit by its physical key. */
const keyMatches = (binding: ParsedBinding, event: KeyChord): boolean =>
  /^[0-9]$/.test(binding.key)
    ? event.code === `Digit${binding.key}`
    : event.key.toLowerCase() === binding.key.toLowerCase();

/**
 * The bar command a key in the modal dispatches: PAPERCRAFT_KEYBINDINGS without
 * SEND_COMMAND (CmdOrCtrl+Enter stays chat's). CmdOrCtrl = Meta or Ctrl (one);
 * a digit key matches by `code` (`Shift+1` = `Digit1`); `undefined` when
 * already default-prevented or unmatched.
 */
export const keyCommandOf = (event: KeyChord): ModalCommand | undefined => {
  if (event.defaultPrevented || event.altKey) return undefined;

  const cmdOrCtrl = event.metaKey !== event.ctrlKey;
  if ((event.metaKey || event.ctrlKey) && !cmdOrCtrl) return undefined;

  return modalBindings.find(
    (binding) =>
      binding.cmdOrCtrl === cmdOrCtrl &&
      binding.shift === event.shiftKey &&
      keyMatches(binding, event),
  )?.command;
};
