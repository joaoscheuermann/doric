// `papercraft.snapshot/v1` (desktopMain): a window captures a rectangle of its
// own viewport and gets the PNG main took. The window is the call's
// `windowKey`, which the desktop dispatcher fills, so a window only ever gets
// its own pixels; a rectangle that is not one is refused before anything is
// captured; and a capture main could not take reaches the window as a
// contract error. Main is faked at its boundary: a few open windows, each with
// a viewport and the PNG a capture of it answers.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type CallScope,
  ContractError,
  isContractError,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import {
  PapercraftSnapshotV1,
  SNAPSHOT_MAX_SIDE,
  type Snapshot,
  type SnapshotRect,
} from '../src/contracts/index.js';
import {
  snapshotService,
  type WindowCapture,
} from '../src/desktop/snapshot.js';

interface FakeWindow {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly png: string;
  readonly scale: number;
}

/** Main's capture over a set of open windows, recording what it captured. */
const fakeMain = (
  windows: Readonly<Record<string, FakeWindow>>,
  failure?: () => Error,
) => {
  const captured: string[] = [];
  const capture: WindowCapture = {
    capture: ({ key, rect }) => {
      const window = windows[key];

      if (window === undefined) {
        return Promise.reject(
          new ContractError('not_found', `No window "${key}" is open.`),
        );
      }

      if (failure !== undefined) {
        return Promise.reject(failure());
      }

      if (
        rect.x + rect.width > window.viewport.width ||
        rect.y + rect.height > window.viewport.height
      ) {
        return Promise.reject(
          new ContractError('invalid_input', 'Outside the viewport.'),
        );
      }

      captured.push(key);

      return Promise.resolve({
        png: window.png,
        width: Math.round(rect.width * window.scale),
        height: Math.round(rect.height * window.scale),
        scale: window.scale,
      });
    },
  };

  return { capture, captured };
};

const WINDOWS = {
  workspace: {
    viewport: { width: 1440, height: 900 },
    png: 'd29ya3NwYWNl',
    scale: 2,
  },
  settings: {
    viewport: { width: 1200, height: 800 },
    png: 'c2V0dGluZ3M=',
    scale: 1,
  },
} as const satisfies Record<string, FakeWindow>;

/** The provider over a fake main, and the capture a window of `scope` calls. */
const harnessOf = (main: ReturnType<typeof fakeMain>) => {
  const harness = createTestServices({ bundle: { id: 'papercraft' } });

  harness.services.provide(snapshotService(() => main.capture));

  return {
    // The stub validates the input as it is called; `async` turns that refusal
    // into the rejection a window sees over the bridge.
    capture: async (input: unknown, scope?: CallScope) =>
      harness.services
        .use(PapercraftSnapshotV1, scope)
        .capture(input as { rect: SnapshotRect }),
    dispose: () => harness.dispose(),
  };
};

const RECT = { x: 16, y: 24, width: 320, height: 200 };

/** The contract error code a rejected capture fails with. */
const codeOf = async (pending: Promise<Snapshot>): Promise<string> => {
  try {
    await pending;
  } catch (error) {
    assert.ok(isContractError(error), String(error));

    return error.code;
  }

  assert.fail('the capture succeeded');
};

test('a window gets the PNG of its own rectangle, at its device scale', async () => {
  const main = fakeMain(WINDOWS);
  const harness = harnessOf(main);

  try {
    assert.deepEqual(
      await harness.capture({ rect: RECT }, { windowKey: 'workspace' }),
      { png: WINDOWS.workspace.png, width: 640, height: 400, scale: 2 },
    );
    assert.deepEqual(
      await harness.capture({ rect: RECT }, { windowKey: 'settings' }),
      { png: WINDOWS.settings.png, width: 320, height: 200, scale: 1 },
    );
  } finally {
    await harness.dispose();
  }
});

test('a window cannot name another window to capture', async () => {
  const main = fakeMain(WINDOWS);
  const harness = harnessOf(main);

  try {
    for (const input of [
      { rect: RECT, key: 'workspace' },
      { rect: RECT, windowKey: 'workspace' },
    ]) {
      assert.equal(
        await codeOf(harness.capture(input, { windowKey: 'settings' })),
        'invalid_input',
        JSON.stringify(input),
      );
    }

    assert.deepEqual(main.captured, []);
  } finally {
    await harness.dispose();
  }
});

test('a call that did not leave a window captures nothing', async () => {
  const main = fakeMain(WINDOWS);
  const harness = harnessOf(main);

  try {
    assert.equal(await codeOf(harness.capture({ rect: RECT })), 'unavailable');
    assert.equal(
      await codeOf(harness.capture({ rect: RECT }, { projectId: 'p1' })),
      'unavailable',
    );
    assert.deepEqual(main.captured, []);
  } finally {
    await harness.dispose();
  }
});

test('the largest side a capture takes is accepted', async () => {
  const main = fakeMain({
    tall: {
      viewport: { width: SNAPSHOT_MAX_SIDE, height: SNAPSHOT_MAX_SIDE },
      png: 'dGFsbA==',
      scale: 1,
    },
  });
  const harness = harnessOf(main);

  try {
    const snapshot = await harness.capture(
      {
        rect: {
          x: 0,
          y: 0,
          width: SNAPSHOT_MAX_SIDE,
          height: SNAPSHOT_MAX_SIDE,
        },
      },
      { windowKey: 'tall' },
    );

    assert.equal(snapshot.png, 'dGFsbA==');
  } finally {
    await harness.dispose();
  }
});

test('a rectangle that is not one is refused before anything is captured', async () => {
  const main = fakeMain(WINDOWS);
  const harness = harnessOf(main);
  const invalid: Record<string, unknown> = {
    'no rect': {},
    'a missing side': { rect: { x: 0, y: 0, width: 10 } },
    'a zero width': { rect: { ...RECT, width: 0 } },
    'a negative height': { rect: { ...RECT, height: -5 } },
    'a negative origin': { rect: { ...RECT, x: -1 } },
    'a NaN side': { rect: { ...RECT, width: Number.NaN } },
    'an infinite side': { rect: { ...RECT, height: Number.POSITIVE_INFINITY } },
    'an infinite origin': { rect: { ...RECT, y: Number.POSITIVE_INFINITY } },
    'a side past the maximum': {
      rect: { ...RECT, width: SNAPSHOT_MAX_SIDE + 0.5 },
    },
    'a side given as text': { rect: { ...RECT, width: '320' } },
    'an extra field': { rect: { ...RECT, scale: 2 } },
  };

  try {
    for (const [name, input] of Object.entries(invalid)) {
      assert.equal(
        await codeOf(harness.capture(input, { windowKey: 'workspace' })),
        'invalid_input',
        name,
      );
    }

    assert.deepEqual(main.captured, []);
  } finally {
    await harness.dispose();
  }
});

test('a rectangle outside the viewport is refused as main refuses it', async () => {
  const harness = harnessOf(fakeMain(WINDOWS));

  try {
    assert.equal(
      await codeOf(
        harness.capture(
          { rect: { x: 1300, y: 0, width: 200, height: 100 } },
          { windowKey: 'workspace' },
        ),
      ),
      'invalid_input',
    );
  } finally {
    await harness.dispose();
  }
});

test('a window that closed before the capture fails not_found', async () => {
  const harness = harnessOf(fakeMain(WINDOWS));

  try {
    assert.equal(
      await codeOf(harness.capture({ rect: RECT }, { windowKey: 'gone' })),
      'not_found',
    );
  } finally {
    await harness.dispose();
  }
});

test('a capture main could not take surfaces as a contract error', async () => {
  const harness = harnessOf(
    fakeMain(WINDOWS, () => new Error('capturePage failed')),
  );

  try {
    assert.equal(
      await codeOf(harness.capture({ rect: RECT }, { windowKey: 'workspace' })),
      'unavailable',
    );
  } finally {
    await harness.dispose();
  }
});

test('a capture main answered with no image is refused', async () => {
  const main = fakeMain(WINDOWS);
  const harness = createTestServices({ bundle: { id: 'papercraft' } });

  harness.services.provide(
    snapshotService(() => ({
      capture: async (input, call) => ({
        ...(await main.capture.capture(input, call)),
        png: '',
      }),
    })),
  );

  try {
    assert.equal(
      await codeOf(
        harness.services
          .use(PapercraftSnapshotV1, { windowKey: 'workspace' })
          .capture({ rect: RECT }),
      ),
      'invalid_output',
    );
  } finally {
    await harness.dispose();
  }
});

test('without a platform capture, the capture is unavailable', async () => {
  const harness = createTestServices({ bundle: { id: 'papercraft' } });

  harness.services.provide(snapshotService());

  try {
    assert.equal(
      await codeOf(
        harness.services
          .use(PapercraftSnapshotV1, { windowKey: 'workspace' })
          .capture({ rect: RECT }),
      ),
      'unavailable',
    );
  } finally {
    await harness.dispose();
  }
});
