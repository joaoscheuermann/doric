import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import {
  type ArtGpu,
  artOverride,
  pickPhoto,
  requestArtDevice,
  SPLASH_PHOTOS,
  type SplashPhoto,
  startArt,
} from '../src/splash-page/art/choose-art';

// A device the page can destroy and that the platform can lose.
class FakeDevice {
  destroyed = false;
  #loseDevice: (reason: unknown) => void = () => undefined;
  readonly lost = new Promise<unknown>((resolve) => {
    this.#loseDevice = resolve;
  });

  destroy(): void {
    this.destroyed = true;
  }

  lose(): void {
    this.#loseDevice('unknown');
  }
}

const gpuWith = (device: FakeDevice): ArtGpu<FakeDevice> => ({
  requestAdapter: async () => ({ requestDevice: async () => device }),
});

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

// The page's side of `startArt`: what is shown, what was drawn.
const page = (
  options: {
    readonly search?: string;
    readonly gpu?: ArtGpu<FakeDevice>;
    readonly loadPhoto?: (id: SplashPhoto) => Promise<string>;
    readonly draw?: () => () => void;
    readonly random?: () => number;
  } = {},
) => {
  const shown = { shaded: 0, canvases: [] as SplashPhoto[] };
  const resolution = { listener: undefined as (() => void) | undefined };
  const deps = {
    search: options.search ?? '',
    gpu: options.gpu,
    random: options.random ?? (() => 0),
    loadPhoto: options.loadPhoto ?? (async (id: SplashPhoto) => `bitmap ${id}`),
    draw: (_device: FakeDevice, _photo: string, id: SplashPhoto) => {
      shown.canvases.push(id);
      return (options.draw ?? (() => () => undefined))();
    },
    onResolutionChange: (listener: () => void) => {
      resolution.listener = listener;
      return () => {
        resolution.listener = undefined;
      };
    },
    showShaded: () => {
      shown.shaded += 1;
    },
  };

  return { deps, shown, resolution };
};

describe('requestArtDevice', () => {
  test('answers the device when the adapter and device arrive in time', async () => {
    const device = new FakeDevice();

    assert.equal(await requestArtDevice(gpuWith(device)), device);
    assert.equal(device.destroyed, false);
  });

  test('answers undefined without WebGPU', async () => {
    assert.equal(await requestArtDevice(undefined), undefined);
  });

  test('answers undefined when there is no adapter', async () => {
    const gpu: ArtGpu<FakeDevice> = { requestAdapter: async () => null };

    assert.equal(await requestArtDevice(gpu), undefined);
  });

  test('answers undefined when requestAdapter rejects', async () => {
    const gpu: ArtGpu<FakeDevice> = {
      requestAdapter: () => Promise.reject(new Error('blocklisted')),
    };

    assert.equal(await requestArtDevice(gpu), undefined);
  });

  test('answers undefined when requestDevice rejects', async () => {
    const gpu: ArtGpu<FakeDevice> = {
      requestAdapter: async () => ({
        requestDevice: () => Promise.reject(new Error('lost')),
      }),
    };

    assert.equal(await requestArtDevice(gpu), undefined);
  });

  describe('with a fake clock', () => {
    beforeEach(() => {
      mock.timers.enable({ apis: ['setTimeout'] });
    });

    afterEach(() => {
      mock.timers.reset();
    });

    test('answers undefined after 1000 ms when requestAdapter never settles', async () => {
      const gpu: ArtGpu<FakeDevice> = {
        requestAdapter: () => new Promise(() => undefined),
      };
      let answer: FakeDevice | undefined | 'pending' = 'pending';

      void requestArtDevice(gpu).then((device) => {
        answer = device;
      });
      mock.timers.tick(999);
      await settle();
      assert.equal(answer, 'pending');

      mock.timers.tick(1);
      await settle();
      assert.equal(answer, undefined);
    });

    test('destroys a device that arrives after the 1000 ms', async () => {
      const device = new FakeDevice();
      let arrive: (value: FakeDevice) => void = () => undefined;
      const gpu: ArtGpu<FakeDevice> = {
        requestAdapter: async () => ({
          requestDevice: () =>
            new Promise<FakeDevice>((resolve) => {
              arrive = resolve;
            }),
        }),
      };

      const answer = requestArtDevice(gpu);
      await settle();
      mock.timers.tick(1000);
      assert.equal(await answer, undefined);

      arrive(device);
      await settle();
      assert.equal(device.destroyed, true);
    });
  });
});

describe('artOverride', () => {
  test('answers shaded for ?art=shaded only', () => {
    assert.equal(artOverride('?art=shaded'), 'shaded');
    assert.equal(artOverride('?theme=dark&art=shaded'), 'shaded');
    assert.equal(artOverride(''), undefined);
    assert.equal(artOverride('?art=shader'), undefined);
    assert.equal(artOverride('?art=shaded2'), undefined);
    assert.equal(artOverride('?shaded'), undefined);
  });
});

describe('pickPhoto', () => {
  test('splits the random range evenly over the three photographs', () => {
    assert.deepEqual(SPLASH_PHOTOS, [
      'M1mNrZ3t7bI',
      'ycojSfbMZQc',
      'yEsyprCZcEY',
    ]);
    assert.equal(
      pickPhoto(() => 0),
      'M1mNrZ3t7bI',
    );
    assert.equal(
      pickPhoto(() => 0.34),
      'ycojSfbMZQc',
    );
    assert.equal(
      pickPhoto(() => 0.67),
      'yEsyprCZcEY',
    );
    assert.equal(
      pickPhoto(() => 0.9999999),
      'yEsyprCZcEY',
    );
  });

  test('answers one of the photographs with Math.random', () => {
    assert.ok(SPLASH_PHOTOS.includes(pickPhoto()));
  });
});

describe('startArt', () => {
  test('?art=shaded shows the shaded image and never asks for an adapter', async () => {
    let asked = false;
    const gpu: ArtGpu<FakeDevice> = {
      requestAdapter: async () => {
        asked = true;
        return null;
      },
    };
    const { deps, shown } = page({ search: '?art=shaded', gpu });

    assert.equal(await startArt(deps), 'shaded');
    assert.equal(asked, false);
    assert.equal(shown.shaded, 1);
    assert.deepEqual(shown.canvases, []);
  });

  test('without a device it shows the shaded image', async () => {
    const { deps, shown } = page({ gpu: undefined });

    assert.equal(await startArt(deps), 'shaded');
    assert.equal(shown.shaded, 1);
    assert.deepEqual(shown.canvases, []);
  });

  test('with a device it shades the picked photograph', async () => {
    const device = new FakeDevice();
    const { deps, shown } = page({ gpu: gpuWith(device), random: () => 0.5 });

    assert.equal(await startArt(deps), 'shader');
    assert.deepEqual(shown.canvases, ['ycojSfbMZQc']);
    assert.equal(shown.shaded, 0);
    assert.equal(device.destroyed, false);
  });

  test('a photograph that fails to decode destroys the device and shows the shaded image', async () => {
    const device = new FakeDevice();
    const { deps, shown } = page({
      gpu: gpuWith(device),
      loadPhoto: () => Promise.reject(new Error('decode')),
    });

    assert.equal(await startArt(deps), 'shaded');
    assert.equal(device.destroyed, true);
    assert.equal(shown.shaded, 1);
  });

  test('a draw that throws destroys the device and shows the shaded image', async () => {
    const device = new FakeDevice();
    const { deps, shown } = page({
      gpu: gpuWith(device),
      draw: () => {
        throw new Error('grid exceeds the buffer limits');
      },
    });

    assert.equal(await startArt(deps), 'shaded');
    assert.equal(device.destroyed, true);
    assert.equal(shown.shaded, 1);
  });

  test('a device lost after the draw shows the shaded image', async () => {
    const device = new FakeDevice();
    const { deps, shown } = page({ gpu: gpuWith(device) });

    assert.equal(await startArt(deps), 'shader');
    device.lose();
    await settle();

    assert.equal(device.destroyed, true);
    assert.equal(shown.shaded, 1);
  });

  test('a resolution change draws again', async () => {
    let draws = 0;
    const { deps, shown, resolution } = page({
      gpu: gpuWith(new FakeDevice()),
      draw: () => () => {
        draws += 1;
      },
    });

    await startArt(deps);
    resolution.listener?.();
    resolution.listener?.();

    assert.equal(draws, 2);
    assert.equal(shown.shaded, 0);
  });

  test('a redraw that throws shows the shaded image', async () => {
    const device = new FakeDevice();
    const { deps, shown, resolution } = page({
      gpu: gpuWith(device),
      draw: () => () => {
        throw new Error('lost context');
      },
    });

    await startArt(deps);
    resolution.listener?.();

    assert.equal(device.destroyed, true);
    assert.equal(shown.shaded, 1);
  });

  test('two failures show the shaded image once', async () => {
    const device = new FakeDevice();
    const { deps, shown, resolution } = page({
      gpu: gpuWith(device),
      draw: () => () => {
        throw new Error('lost context');
      },
    });

    await startArt(deps);
    resolution.listener?.();
    device.lose();
    await settle();
    resolution.listener?.();

    assert.equal(shown.shaded, 1);
  });
});
