// Every decision of the splash art (§4.5, S32, S33), with structural types
// only, so it compiles and runs in Node: whether to ask for WebGPU, how long to
// wait for a device, which photograph to shade, and when to fall back to the
// shaded export. `splash.ts` wires the page's DOM and WebGPU into `startArt`.

/** The part of `navigator.gpu` the art uses. */
export type ArtGpu<D> = {
  requestAdapter(): Promise<{ requestDevice(): Promise<D> } | null>;
};

/** The photographs bundled beside the page, by Unsplash id (S33). */
export const SPLASH_PHOTOS = [
  'M1mNrZ3t7bI',
  'ycojSfbMZQc',
  'yEsyprCZcEY',
] as const;

export type SplashPhoto = (typeof SPLASH_PHOTOS)[number];

/**
 * Asks for an adapter, then a device, both within `timeoutMs` of the
 * `requestAdapter` call. Answers `undefined` when `gpu` is missing, the adapter
 * is `null`, either call rejects or the time passes; a device that arrives
 * after the time is destroyed unused.
 */
export function requestArtDevice<D extends { destroy(): void }>(
  gpu: ArtGpu<D> | undefined,
  timeoutMs = 1000,
): Promise<D | undefined> {
  if (gpu === undefined) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      resolve(undefined);
    }, timeoutMs);
    const request = async (): Promise<D | undefined> => {
      const adapter = await gpu.requestAdapter();

      return adapter === null ? undefined : adapter.requestDevice();
    };

    request().then(
      (device) => {
        if (late) {
          device?.destroy();

          return;
        }

        clearTimeout(timer);
        resolve(device);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** `'shaded'` when the query's `art` parameter is exactly `shaded`. */
export function artOverride(search: string): 'shaded' | undefined {
  return new URLSearchParams(search).get('art') === 'shaded'
    ? 'shaded'
    : undefined;
}

/** A uniform pick of one of `SPLASH_PHOTOS`. */
export function pickPhoto(random: () => number = Math.random): SplashPhoto {
  const n = SPLASH_PHOTOS.length;

  return SPLASH_PHOTOS[
    Math.min(n - 1, Math.floor(random() * n))
  ] as SplashPhoto;
}

export type StartArtDeps<
  D extends { destroy(): void; readonly lost: Promise<unknown> },
  P,
> = {
  /** The page's `location.search`. */
  readonly search: string;
  /** `navigator.gpu`, `undefined` without WebGPU. */
  readonly gpu: ArtGpu<D> | undefined;
  readonly random?: () => number;
  readonly timeoutMs?: number;
  /** Loads and decodes the photograph; rejects when it fails to decode. */
  readonly loadPhoto: (id: SplashPhoto) => Promise<P>;
  /** Inserts the canvas, draws once and answers the redraw. */
  readonly draw: (device: D, photo: P, id: SplashPhoto) => () => void;
  /** Calls the listener on each device-pixel-ratio change; answers the stop. */
  readonly onResolutionChange: (listener: () => void) => () => void;
  /** Removes any canvas and shows `art-shaded.webp`. */
  readonly showShaded: () => void;
};

/**
 * Shows the art: the picked photograph shaded live when a device arrives in
 * time and everything draws, else the shaded export. Answers which one.
 */
export async function startArt<
  D extends { destroy(): void; readonly lost: Promise<unknown> },
  P,
>(deps: StartArtDeps<D, P>): Promise<'shader' | 'shaded'> {
  let shaded = false;
  const showShaded = (): 'shaded' => {
    if (!shaded) {
      shaded = true;
      deps.showShaded();
    }

    return 'shaded';
  };

  if (artOverride(deps.search) === 'shaded') {
    return showShaded();
  }

  const device = await requestArtDevice(deps.gpu, deps.timeoutMs);

  if (device === undefined) {
    return showShaded();
  }

  // From here on, every failure gives the device up and shows the export.
  let held = true;
  let stopListening = (): void => undefined;
  const fail = (): 'shaded' => {
    stopListening();

    if (held) {
      held = false;
      device.destroy();
    }

    return showShaded();
  };
  const id = pickPhoto(deps.random);
  let redraw: () => void;

  try {
    redraw = deps.draw(device, await deps.loadPhoto(id), id);
  } catch {
    return fail();
  }

  void device.lost.then(fail);
  stopListening = deps.onResolutionChange(() => {
    try {
      redraw();
    } catch {
      fail();
    }
  });

  return 'shader';
}
