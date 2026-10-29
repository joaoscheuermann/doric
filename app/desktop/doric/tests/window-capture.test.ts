// `doric.windows/v1.capture` (1.2.0) without Electron: main captures a CSS-px
// rectangle of an open path window's viewport. The web contents and its
// `capturePage` are the native boundary, faked here; the registry, the
// windows and the broker are the real ones.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DoricWindowsV1 } from 'bundle/contracts';
import {
  createPrincipal,
  PLATFORM_VERSION,
  ServiceDirectory,
} from 'bundle/runtime';

import { provideBroker } from '../src/platform/generation/broker';
import { silentLog } from '../src/platform/log';
import { NativeWindows } from '../src/platform/windows/native-windows';
import {
  type WindowEntry,
  WindowRegistry,
} from '../src/platform/windows/registry';

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A fake page: its zoom, its window's content size and what it captures. */
const fakeWindow = (input: {
  readonly key: string;
  readonly kind?: 'path' | 'view';
  readonly zoom?: number;
  readonly content?: readonly [number, number];
  readonly destroyed?: boolean;
  /** Device pixels per DIP of the captured image; 0 gives an empty image. */
  readonly density?: number;
  readonly fails?: boolean;
}) => {
  const captured: Rect[] = [];
  const density = input.density ?? 2;
  const contents = {
    id: Math.floor(Math.random() * 1e9),
    isDestroyed: () => input.destroyed === true,
    getZoomFactor: () => input.zoom ?? 1,
    capturePage: async (rect: Rect) => {
      captured.push(rect);

      if (input.fails === true) {
        throw new Error('The GPU process is gone.');
      }

      const size = {
        width: Math.round(rect.width * density),
        height: Math.round(rect.height * density),
      };

      return {
        isEmpty: () => density === 0,
        getScaleFactors: () => (density === 0 ? [] : [density]),
        getSize: (factor = 1) => (factor === density ? size : { ...size }),
        toPNG: () => Buffer.from(`png ${size.width}x${size.height}`),
      };
    },
  };
  const entry = {
    key: input.key,
    kind: input.kind ?? 'path',
    window: { getContentSize: () => [...(input.content ?? [800, 600])] },
    contents,
    appearance: {},
    primary: false,
    pinnedGeneration: null,
    context: { path: null, focus: null },
  } as unknown as WindowEntry;

  return { entry, captured };
};

const windowsWith = (...entries: WindowEntry[]) => {
  const registry = new WindowRegistry();

  for (const entry of entries) {
    registry.add(entry);
  }

  return new NativeWindows({ registry } as never);
};

const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});

describe('capturing a window region', () => {
  test('answers the PNG of the region, its device size and the device pixels per CSS px', async () => {
    const page = fakeWindow({ key: 'canvas', density: 2 });
    const shot = await windowsWith(page.entry).capture({
      key: 'canvas',
      rect: rect(10, 20, 300, 150),
    });

    assert.deepEqual(shot, {
      png: Buffer.from('png 600x300').toString('base64'),
      width: 600,
      height: 300,
      scale: 2,
    });
  });

  test('scales the region by the page zoom, outward to whole DIPs', async () => {
    const page = fakeWindow({ key: 'canvas', zoom: 1.5, density: 1 });
    const shot = await windowsWith(page.entry).capture({
      key: 'canvas',
      rect: rect(10.2, 5, 100, 50),
    });

    // x 15.3 → 15, right 165.3 → 166; y 7.5 → 7, bottom 82.5 → 83.
    assert.deepEqual(page.captured, [rect(15, 7, 151, 76)]);
    assert.equal(shot.width, 151);
    assert.equal(shot.scale, 1.51);
  });

  test('a region up to the viewport edge is inside; one past it fails invalid_input', async () => {
    const page = fakeWindow({ key: 'canvas', zoom: 2, content: [800, 600] });
    const windows = windowsWith(page.entry);

    // The CSS viewport is 400×300 at zoom 2.
    await windows.capture({ key: 'canvas', rect: rect(0, 0, 400, 300) });

    for (const outside of [
      rect(0, 0, 401, 300),
      rect(0, 0, 400, 301),
      rect(200, 0, 300, 100),
      rect(0, 250, 100, 100),
    ]) {
      await assert.rejects(
        windows.capture({ key: 'canvas', rect: outside }),
        { code: 'invalid_input' },
        JSON.stringify(outside),
      );
    }
  });

  test('a key that is not open, or whose contents are gone, fails not_found', async () => {
    const gone = fakeWindow({ key: 'gone', destroyed: true });
    const windows = windowsWith(gone.entry);

    for (const key of ['missing', 'gone']) {
      await assert.rejects(
        windows.capture({ key, rect: rect(0, 0, 10, 10) }),
        { code: 'not_found' },
        key,
      );
    }

    assert.deepEqual(gone.captured, []);
  });

  test('a view window fails invalid_input: only app windows are captured', async () => {
    const view = fakeWindow({ key: 'screen', kind: 'view' });

    await assert.rejects(
      windowsWith(view.entry).capture({
        key: 'screen',
        rect: rect(0, 0, 10, 10),
      }),
      { code: 'invalid_input' },
    );
    assert.deepEqual(view.captured, []);
  });

  test('a capture that throws or comes back empty fails unavailable', async () => {
    for (const page of [
      fakeWindow({ key: 'canvas', fails: true }),
      fakeWindow({ key: 'canvas', density: 0 }),
    ]) {
      await assert.rejects(
        windowsWith(page.entry).capture({
          key: 'canvas',
          rect: rect(0, 0, 10, 10),
        }),
        { code: 'unavailable' },
      );
    }
  });
});

describe('doric.windows/v1 capture (broker)', () => {
  const platform = () => {
    const principal = createPrincipal(
      {
        directory: new ServiceDirectory(),
        catalog: {
          cardinality: () => undefined,
          activeProvider: () => undefined,
        },
        environment: 'desktopMain',
        generation: 0,
        generationSignal: new AbortController().signal,
        report: () => undefined,
      },
      {
        bundleId: 'doric',
        version: PLATFORM_VERSION,
        provides: 'any',
        requires: 'any',
      },
    );
    const page = fakeWindow({ key: 'canvas', density: 2 });
    const windows = windowsWith(page.entry);

    provideBroker(principal, {
      windows: {
        open: async () => undefined,
        focusOrOpen: async () => undefined,
        lastPath: () => null,
        focus: () => false,
        navigate: async () => undefined,
        capture: (input) => windows.capture(input),
      },
      menus: {
        setSkeleton: () => undefined,
        add: () => undefined,
        addKeybinding: () => undefined,
        setContext: () => undefined,
      },
      cacheDirectory: async () => '/cache',
      migrateStorage: async () => 'none',
      tokens: () => ({}),
      notify: () => undefined,
      drawio: {
        describe: () => ({ available: false, reason: 'missing-assets' }),
      },
      log: silentLog,
    });

    return { windows: principal.services.use(DoricWindowsV1), page };
  };

  test('captures through the platform service', async () => {
    const { windows } = platform();

    assert.deepEqual(
      await windows.capture({ key: 'canvas', rect: rect(0, 0, 100, 40) }),
      {
        png: Buffer.from('png 200x80').toString('base64'),
        width: 200,
        height: 80,
        scale: 2,
      },
    );
  });

  test("keeps main's error codes", async () => {
    const { windows } = platform();

    await assert.rejects(
      windows.capture({ key: 'missing', rect: rect(0, 0, 10, 10) }),
      { code: 'not_found' },
    );
  });

  test('refuses a request outside the schema before it reaches a window', async () => {
    const { windows, page } = platform();

    for (const input of [
      { key: '', rect: rect(0, 0, 10, 10) },
      { key: 'canvas', rect: rect(-1, 0, 10, 10) },
      { key: 'canvas', rect: rect(0, 0, 0, 10) },
      { key: 'canvas', rect: rect(0, 0, 10, 4097) },
      { key: 'canvas', rect: { ...rect(0, 0, 10, 10), z: 1 } },
      { key: 'canvas', rect: rect(0, 0, 10, 10), window: 'other' },
    ]) {
      await assert.rejects(
        async () => windows.capture(input as never),
        { code: 'invalid_input' },
        JSON.stringify(input),
      );
    }

    assert.deepEqual(page.captured, []);
  });
});
