// `papercraft.snapshot/v1` in desktopMain: a window asks for a rectangle of its
// own viewport and gets a PNG back (isolamento.md, "O snapshot").
//
// The window is never an input. It is the `windowKey` of the call, which the
// desktop dispatcher fills for every call leaving a window and which a window
// cannot set itself, so a window can only capture itself. A call that did not
// leave a window has nothing to capture.
//
// The pixels come from main: a desktopMain generation runs in a utility
// process, with no `webContents` of its own, so the capture is the platform's
// `doric.windows/v1.capture` (`webContents.capturePage` over the window's
// contents, which takes in the opaque-origin preview frames and the device
// pixel ratio). It reaches this module through `WindowCapture`, so the provider
// is the same whichever side answers it.

import {
  type CallArg,
  ContractError,
  defineMethod,
  defineService,
  isContractError,
  ref,
  type Services,
  windowScopeKey,
} from 'bundle/contracts';

import {
  PapercraftSnapshotV1,
  papercraftSnapshotMethods,
  type Snapshot,
  type SnapshotRect,
} from '../contracts/index.js';

/**
 * The capture main performs for one open path window: `rect` in CSS px of the
 * window's viewport. It fails `not_found` for a window that is not open,
 * `invalid_input` for a rectangle outside the viewport, and `unavailable` for
 * a capture it could not take.
 */
export interface WindowCapture {
  capture(
    input: { readonly key: string; readonly rect: SnapshotRect },
    call?: CallArg,
  ): Promise<Snapshot>;
}

/** `doric.windows/v1`, seen through its `capture` method only. */
const DoricWindowCaptureV1 = ref<WindowCapture>('doric.windows/v1');

/** The platform's capture, as this generation reaches main. */
export const platformCapture = (services: Services): WindowCapture =>
  services.use(DoricWindowCaptureV1);

/**
 * A failed capture as the contract error the window reads: main's own contract
 * errors keep their code (the window closed, the rectangle left the viewport),
 * and anything else is a capture that could not be taken.
 */
const captureFailure = (error: unknown, key: string): Error =>
  isContractError(error)
    ? error
    : new ContractError(
        'unavailable',
        `Window "${key}" could not be captured.`,
        {
          windowKey: key,
          cause: error instanceof Error ? error.message : String(error),
        },
      );

/**
 * The `papercraft.snapshot/v1` definition over a capture. `captureOf` answers
 * the capture for the services of one call; the default is the platform's.
 */
export const snapshotService = (
  captureOf: (services: Services) => WindowCapture = platformCapture,
) =>
  defineService(PapercraftSnapshotV1, {
    capture: defineMethod({
      ...papercraftSnapshotMethods.capture,
      execute: async ({ rect }, call, services) => {
        const key = call.scope?.[windowScopeKey];

        if (key === undefined || key === '') {
          throw new ContractError(
            'unavailable',
            'Only a window captures itself, and this call did not come from one.',
          );
        }

        try {
          return await captureOf(services).capture({ key, rect }, call);
        } catch (error) {
          throw captureFailure(error, key);
        }
      },
    }),
  });
