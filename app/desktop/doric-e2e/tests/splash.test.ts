// The splash and recovery surface in a real window: what each state shows,
// its buttons by accessible name, and the `act` round trip to main. Plus the
// minimal test core (core.md): the platform does not depend on the default
// core.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { app, nativeTheme, type WebContents } from 'electron';

import type { SplashState } from '../../doric/src/platform/splash/protocol';
import { SPLASH_PHOTOS } from '../../doric/src/splash-page/art/choose-art';
import { coreDistribution } from '../../doric/tests/support/core';
import {
  type Booted,
  bootPlatform,
  page,
  startFakeHost,
  until,
} from './support/harness';
import { captureSplash } from './support/shell-page';

const splashContents = (booted: Booted): Promise<WebContents> =>
  until(() => {
    const contents = booted.platform.splashWindow?.webContents;

    return contents !== undefined && !contents.isLoading()
      ? contents
      : undefined;
  }, 'the splash page');

const buttons = (contents: WebContents) =>
  page<string[]>(
    contents,
    `[...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent)`,
  );

const text = (contents: WebContents) =>
  page<string>(contents, `document.querySelector('main').innerText`);

/** The wordmark: one inline SVG named "Doric". */
const wordmarks = (contents: WebContents) =>
  page<number>(
    contents,
    `document.querySelectorAll('svg[aria-label="Doric"]').length`,
  );

/** The links by accessible name. */
const links = (contents: WebContents) =>
  page<string[]>(
    contents,
    `[...document.querySelectorAll('a')].map((a) => a.getAttribute('aria-label') ?? a.textContent.trim())`,
  );

/** What the art pane holds: each child's `data-art` (and `data-photo`). */
const art = (contents: WebContents) =>
  page<string[]>(
    contents,
    `[...(document.querySelector('[data-art-pane]')?.children ?? [])].map((node) => node.dataset.art + (node.dataset.photo ? ':' + node.dataset.photo : ''))`,
  );

/**
 * Waits until the art pane shows its art and answers it: exactly one of the
 * shader canvas on a bundled photograph (`shader:<id>`) or the shaded image
 * (S32). Until one is drawn the pane is empty.
 */
const shownArt = async (contents: WebContents): Promise<string> => {
  const shown = await until(async () => {
    const children = await art(contents);

    return children.length > 0 ? children : undefined;
  }, 'the art');

  assert.equal(shown.length, 1, `one art, not ${JSON.stringify(shown)}`);

  const [one] = shown;

  assert.ok(
    one === 'shaded' || SPLASH_PHOTOS.some((id) => one === `shader:${id}`),
    one,
  );

  return one;
};

/** Runs `body` with `DORIC_SPLASH_ART` set to `value` (unset when undefined). */
const withSplashArt = async <T>(
  value: string | undefined,
  body: () => Promise<T>,
): Promise<T> => {
  const previous = process.env.DORIC_SPLASH_ART;

  if (value === undefined) {
    delete process.env.DORIC_SPLASH_ART;
  } else {
    process.env.DORIC_SPLASH_ART = value;
  }

  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.DORIC_SPLASH_ART;
    } else {
      process.env.DORIC_SPLASH_ART = previous;
    }
  }
};

/** The status line's text, or '' while it is hidden. */
const statusText = (contents: WebContents) =>
  page<string>(
    contents,
    `(() => { const node = document.querySelector('.splash-status'); return node && !node.hidden ? node.innerText.trim() : ''; })()`,
  );

/** The status line's icon: `spinner`, `alert`, or '' without one. */
const statusIcon = (contents: WebContents) =>
  page<string>(
    contents,
    `document.querySelector('.splash-status:not([hidden]) > svg')?.dataset.icon ?? ''`,
  );

const detailsText = (contents: WebContents) =>
  page<string>(
    contents,
    `(() => { const node = document.querySelector('.splash-details'); return node && !node.hidden ? node.innerText.trim() : ''; })()`,
  );

/** Every state the page draws (§4.5, T-4.5.1), with what it must show. */
const STATES: readonly {
  readonly name: string;
  readonly state: SplashState;
  readonly status: string;
  readonly icon: 'spinner' | 'alert' | '';
  readonly details: string;
  readonly buttons: readonly string[];
}[] = [
  {
    name: 'connecting',
    state: { state: 'loading', step: 'connecting' },
    status: 'Connecting to the host',
    icon: 'spinner',
    details: '',
    buttons: [],
  },
  {
    name: 'catalog',
    state: { state: 'loading', step: 'catalog' },
    status: 'Reading the catalog',
    icon: 'spinner',
    details: '',
    buttons: [],
  },
  {
    name: 'download',
    state: {
      state: 'loading',
      step: 'download',
      progress: { done: 3, total: 7 },
    },
    status: 'Downloading bundles (3/7)',
    icon: 'spinner',
    details: '',
    buttons: [],
  },
  {
    name: 'verify',
    state: { state: 'loading', step: 'verify' },
    status: 'Verifying bundles',
    icon: 'spinner',
    details: '',
    buttons: [],
  },
  {
    name: 'activation',
    state: { state: 'loading', step: 'activation' },
    status: 'Activating',
    icon: 'spinner',
    details: '',
    buttons: [],
  },
  {
    name: 'host-unreachable',
    state: {
      state: 'host-unreachable',
      hostUrl: 'http://127.0.0.1:3000',
      lastError: 'connect ECONNREFUSED 127.0.0.1:3000',
      attempts: 3,
      hasSnapshot: true,
    },
    status: 'Cannot reach http://127.0.0.1:3000',
    icon: 'alert',
    details: 'connect ECONNREFUSED 127.0.0.1:3000 · Attempt 3',
    buttons: ['Retry', 'Open last known composition'],
  },
  {
    name: 'bundle-failure',
    state: {
      state: 'bundle-failure',
      bundles: [
        {
          id: 'probe-new',
          version: '1.0.0',
          reasons: [
            {
              code: 'engines_unsatisfied',
              message: 'needs doric ^2.0.0',
            },
          ],
        },
      ],
    },
    status: 'Some bundles cannot load',
    icon: 'alert',
    details: 'probe-new 1.0.0: needs doric ^2.0.0',
    buttons: ['Retry', 'Continue without them', 'Disable probe-new'],
  },
  {
    name: 'core-failure',
    state: {
      state: 'core-failure',
      core: { id: 'badcore', version: '1.0.0' },
      error: 'the core broke',
      hasLastGoodCore: true,
    },
    status: 'badcore 1.0.0',
    icon: 'alert',
    details: 'the core broke',
    buttons: [
      'Retry',
      'Use last core that worked',
      'Return to default composition',
    ],
  },
  {
    name: 'recovery',
    state: {
      state: 'recovery',
      reason: 'Recovery was requested',
      hasLastGoodCore: false,
    },
    status: 'Recovery was requested',
    icon: 'alert',
    details: '',
    buttons: ['Retry', 'Return to default composition'],
  },
];

describe('splash and recovery page', () => {
  test('a host that refuses shows where it tried and how often, and Retry reaches main', async () => {
    const host = await startFakeHost(await coreDistribution());

    host.refuse(1_000);

    const booted = await bootPlatform({ host });

    try {
      const contents = await splashContents(booted);

      await until(
        async () => (await text(contents)).includes('Attempt 2') || undefined,
        'a second attempt',
      );

      const shown = await text(contents);

      assert.equal(await wordmarks(contents), 1);
      assert.ok(shown.includes(`Cannot reach ${host.url}`), shown);
      assert.deepEqual(await buttons(contents), ['Retry']);
      assert.equal(await page(contents, 'document.title'), 'Doric');

      host.refuse(0);
      await page(
        contents,
        `document.querySelector('button').click(); 'clicked'`,
      );
      await booted.window('workspace');
    } finally {
      await booted.dispose();
      await host.close();
    }
  });

  test('a core whose desktopMain part fails shows core-failure and offers the default composition and Retry', async () => {
    const { catalog, artifacts } = await coreDistribution({
      core: 'badcore',
      bundles: [
        {
          id: 'badcore',
          phase: 'core',
          files: {
            'desktop/index.js': `export const activate = () => { throw new Error('the core broke'); };`,
          },
        },
      ],
    });
    const host = await startFakeHost({ catalog, artifacts });
    const booted = await bootPlatform({ host });

    try {
      const contents = await splashContents(booted);

      await until(
        async () =>
          (await text(contents)).includes('the core broke') || undefined,
        'the core failure',
      );

      assert.ok((await text(contents)).includes('badcore 1.0.0'));
      assert.deepEqual(await buttons(contents), [
        'Retry',
        'Return to default composition',
      ]);
      assert.equal(booted.platform.registry.all().length, 0);
    } finally {
      await booted.dispose();
      await host.close();
    }
  });

  test('an incompatible client part is reported to the host once and Continue starts the rest', async () => {
    const host = await startFakeHost(
      await coreDistribution({
        bundles: [
          {
            id: 'probe-ok',
            files: { 'client/index.js': 'export const activate = () => {};' },
          },
          {
            id: 'probe-new',
            engines: '^2.0.0',
            files: { 'client/index.js': 'export const activate = () => {};' },
          },
        ],
      }),
    );
    const booted = await bootPlatform({ host });

    try {
      const contents = await splashContents(booted);

      await until(
        async () =>
          (await buttons(contents)).includes('Continue without them') ||
          undefined,
        'the bundle failure',
      );

      const reports = host.calls.filter(
        (call) =>
          call.contract === 'doric.diagnostics/v1' && call.method === 'report',
      );

      assert.ok((await text(contents)).includes('probe-new 1.0.0'));
      assert.deepEqual(await buttons(contents), [
        'Retry',
        'Continue without them',
        'Disable probe-new',
      ]);
      assert.equal(reports.length, 1);

      const input = reports[0]?.input as {
        bundleId: string;
        kind: string;
        details: { reasons: { code: string }[] };
      };

      assert.equal(input.bundleId, 'probe-new');
      assert.equal(input.kind, 'desktop_quarantine');
      assert.deepEqual(
        input.details.reasons.map((reason) => reason.code),
        ['engines_unsatisfied'],
      );

      await page(
        contents,
        `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Continue without them').click(); 'clicked'`,
      );
      await booted.window('workspace');
    } finally {
      await booted.dispose();
      await host.close();
    }
  });

  test('"Disable" asks the host to disable the bundle and starts the generation it publishes', async () => {
    const host = await startFakeHost(
      await coreDistribution({
        bundles: [
          {
            id: 'probe-new',
            engines: '^2.0.0',
            files: { 'client/index.js': 'export const activate = () => {};' },
          },
        ],
      }),
    );
    const next = await coreDistribution({ generation: 2 });

    host.serve('doric.catalog/v1', 'disable', () => {
      host.publish(next.catalog, next.artifacts);
    });

    const booted = await bootPlatform({ host });

    try {
      const contents = await splashContents(booted);

      await until(
        async () =>
          (await buttons(contents)).includes('Disable probe-new') || undefined,
        'the bundle failure',
      );
      await page(
        contents,
        `[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === 'Disable probe-new').click(); 'clicked'`,
      );
      await booted.window('workspace');

      assert.deepEqual(
        host.calls
          .filter(
            (call) =>
              call.contract === 'doric.catalog/v1' && call.method === 'disable',
          )
          .map((call) => call.input),
        [{ bundleId: 'probe-new' }],
      );
    } finally {
      await booted.dispose();
      await host.close();
    }
  });

  test('"Return to default composition" asks the host to reset and starts the generation it publishes', async () => {
    const { catalog, artifacts } = await coreDistribution({
      core: 'badcore',
      bundles: [
        {
          id: 'badcore',
          phase: 'core',
          files: {
            'desktop/index.js': `export const activate = () => { throw new Error('the core broke'); };`,
          },
        },
      ],
    });
    const host = await startFakeHost({ catalog, artifacts });
    const next = await coreDistribution({ generation: 2 });

    host.serve('doric.catalog/v1', 'resetComposition', () => {
      host.publish(next.catalog, next.artifacts);
    });

    const booted = await bootPlatform({ host });

    try {
      const contents = await splashContents(booted);

      await until(
        async () =>
          (await buttons(contents)).includes('Return to default composition') ||
          undefined,
        'the core failure',
      );
      await page(
        contents,
        `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Return to default composition').click(); 'clicked'`,
      );
      await booted.window('workspace');

      assert.ok(
        host.calls.some(
          (call) =>
            call.contract === 'doric.catalog/v1' &&
            call.method === 'resetComposition',
        ),
      );
    } finally {
      await booted.dispose();
      await host.close();
    }
  });

  test('--recovery shows recovery before any window opens', async () => {
    const host = await startFakeHost(await coreDistribution());
    const booted = await bootPlatform({ host, argv: ['--recovery'] });

    try {
      const contents = await splashContents(booted);

      await until(
        async () => (await buttons(contents)).includes('Retry') || undefined,
        'the recovery state',
      );

      assert.ok((await text(contents)).includes('Recovery was requested'));
      assert.deepEqual(await buttons(contents), [
        'Retry',
        'Use last core that worked',
        'Return to default composition',
      ]);
      assert.equal(booted.platform.registry.all().length, 0);
    } finally {
      await booted.dispose();
      await host.close();
    }
  });
});

describe('minimal test core', () => {
  test('a core that only opens its own window starts the app without the default core', async () => {
    const { catalog, artifacts } = await coreDistribution({
      core: 'mincore',
      bundles: [
        {
          id: 'mincore',
          phase: 'core',
          files: {
            'desktop/index.js': `
import { DoricWindowsV1 } from 'bundle/contracts';
export const activate = ({ services }) => {
  void services.use(DoricWindowsV1).open({ key: 'main', path: '/' });
};
`,
          },
        },
      ],
    });
    const host = await startFakeHost({ catalog, artifacts });
    const booted = await bootPlatform({ host });

    try {
      const main = await booted.window('main');

      assert.ok(!catalog.bundles.some((bundle) => bundle.id === 'core'));
      assert.equal(new URL(main.webContents.getURL()).pathname, '/');
      assert.deepEqual(
        booted.platform.registry.all().map((entry) => entry.key),
        ['main'],
      );
      await until(
        () => booted.platform.splashWindow === undefined || undefined,
        'the splash to close',
      );
    } finally {
      await booted.dispose();
      await host.close();
    }
  });
});

describe('disconnected mode', () => {
  test('"Open last known composition" starts the windows from the saved catalog', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const userData = await mkdtemp(join(tmpdir(), 'doric-disconnected-'));
    const host = await startFakeHost(await coreDistribution());

    try {
      // A first run activates and saves the catalog snapshot.
      const first = await bootPlatform({ host, userData });

      await first.window('workspace');
      await first.dispose();

      host.refuse(1_000);

      const second = await bootPlatform({ host, userData });

      try {
        const contents = await splashContents(second);

        await until(
          async () =>
            (await buttons(contents)).includes('Open last known composition') ||
            undefined,
          'the snapshot action',
        );
        await page(
          contents,
          `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Open last known composition').click(); 'clicked'`,
        );

        const workspace = await second.window('workspace');

        assert.equal(second.platform.mode, 'disconnected-copy');
        assert.equal(
          await page(
            workspace.webContents,
            `window.doric.desktop.describeWindow().then((d) => d.mode)`,
          ),
          'disconnected-copy',
        );
      } finally {
        await second.dispose();
      }
    } finally {
      await host.close();
      await rm(userData, { recursive: true, force: true });
    }
  });
});

describe('splash layout (§4.5)', () => {
  test('the splash window is 610×487 and its credits show the app version', async () => {
    const host = await startFakeHost(await coreDistribution());
    const booted = await bootPlatform({ host, argv: ['--recovery'] });

    try {
      const contents = await splashContents(booted);
      const window = booted.platform.splashWindow;

      assert.deepEqual(window?.getContentSize(), [610, 487]);
      await until(
        async () => (await text(contents)).includes('MIT License') || undefined,
        'the credits',
      );

      const shown = await text(contents);

      assert.ok(shown.includes('© 2026 João Vitor Scheuermann'), shown);
      assert.ok(shown.includes(`MIT License · v${app.getVersion()}`), shown);
    } finally {
      await booted.dispose();
      await host.close();
    }
  });

  /** T-4.5.1 in every state of `STATES`, captured dark and light into `dir`. */
  const everyState = async (dir: string | undefined) => {
    const host = await startFakeHost(await coreDistribution());
    const booted = await bootPlatform({ host, argv: ['--recovery'] });
    const themeSource = nativeTheme.themeSource;

    try {
      const contents = await splashContents(booted);

      await until(
        async () => (await buttons(contents)).includes('Retry') || undefined,
        'the recovery state',
      );

      for (const theme of dir === undefined
        ? (['dark'] as const)
        : (['dark', 'light'] as const)) {
        nativeTheme.themeSource = theme;

        for (const expected of STATES) {
          booted.platform.splashStates.set(expected.state);
          await until(
            async () =>
              (await statusText(contents)) === expected.status &&
              (await detailsText(contents)) === expected.details &&
              JSON.stringify(await buttons(contents)) ===
                JSON.stringify(expected.buttons),
            `the ${expected.name} state`,
            5_000,
          ).catch(() => undefined);

          assert.equal(
            await statusText(contents),
            expected.status,
            expected.name,
          );
          assert.equal(
            await statusIcon(contents),
            expected.icon,
            expected.name,
          );
          assert.equal(
            await detailsText(contents),
            expected.details,
            expected.name,
          );
          assert.deepEqual(
            await buttons(contents),
            expected.buttons,
            expected.name,
          );
          assert.equal(await wordmarks(contents), 1, expected.name);
          assert.deepEqual(await links(contents), ['GitHub'], expected.name);
          await shownArt(contents);

          if (dir !== undefined) {
            await captureSplash({ booted, dir, name: expected.name, theme });
          }
        }
      }
    } finally {
      nativeTheme.themeSource = themeSource;
      await booted.dispose();
      await host.close();
    }
  };

  test('every state shows its status, details and buttons by accessible name, with the wordmark, the GitHub link and one art', async () => {
    const dir = process.env.DORIC_SHELL_CAPTURES;

    // The 1:1 captures show the shaded art in every state (§4.5, G15): the
    // shader and its photograph depend on the GPU and on chance.
    await withSplashArt(
      dir === undefined ? process.env.DORIC_SPLASH_ART : 'shaded',
      () => everyState(dir),
    );
  });

  test('the GitHub link asks main to open the repository and leaves the splash where it is', async () => {
    const host = await startFakeHost(await coreDistribution());
    const booted = await bootPlatform({ host, argv: ['--recovery'] });

    try {
      const contents = await splashContents(booted);
      const before = contents.getURL();

      await until(
        async () => (await links(contents)).includes('GitHub') || undefined,
        'the GitHub link',
      );
      await page(
        contents,
        `[...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'GitHub').click(); 'clicked'`,
      );
      await until(() => booted.opened.length > 0 || undefined, 'openExternal');

      assert.deepEqual(booted.opened, [
        'https://github.com/joaoscheuermann/doric',
      ]);
      assert.equal(contents.getURL(), before);
    } finally {
      await booted.dispose();
      await host.close();
    }
  });

  test('DORIC_SPLASH_ART=shaded opens the splash at ?art=shaded with the shaded image', async () => {
    const host = await startFakeHost(await coreDistribution());
    const previous = process.env.DORIC_SPLASH_ART;

    process.env.DORIC_SPLASH_ART = 'shaded';

    const booted = await bootPlatform({ host, argv: ['--recovery'] });

    try {
      const contents = await splashContents(booted);

      assert.equal(new URL(contents.getURL()).search, '?art=shaded');
      assert.equal(await shownArt(contents), 'shaded');
      assert.deepEqual(await art(contents), ['shaded']);

      const dir = process.env.DORIC_SHELL_CAPTURES;

      if (dir !== undefined) {
        await captureSplash({
          booted,
          dir,
          name: 'art-shaded-override',
          theme: 'dark',
        });
      }
    } finally {
      if (previous === undefined) {
        delete process.env.DORIC_SPLASH_ART;
      } else {
        process.env.DORIC_SPLASH_ART = previous;
      }

      await booted.dispose();
      await host.close();
    }
  });
});

describe('splash art (§4.5, T-4.5.7)', () => {
  test('the art pane holds exactly one art: the shader on a bundled photograph or the shaded image', async (t) => {
    await withSplashArt(undefined, async () => {
      const host = await startFakeHost(await coreDistribution());
      const booted = await bootPlatform({ host, argv: ['--recovery'] });
      const themeSource = nativeTheme.themeSource;

      try {
        const contents = await splashContents(booted);

        assert.equal(new URL(contents.getURL()).search, '');

        const shown = await shownArt(contents);

        // Without WebGPU (Xvfb here, G15) this is the shaded image.
        t.diagnostic(`art: ${shown}`);

        const dir = process.env.DORIC_SHELL_CAPTURES;

        // The shader capture of the 1:1 check (G15): on the reference Mac,
        // `splash-art-shader-M1mNrZ3t7bI-<theme>` once that photograph shows.
        if (dir !== undefined) {
          await until(
            async () =>
              (await buttons(contents)).includes('Retry') || undefined,
            'the recovery state',
          );

          for (const theme of ['dark', 'light'] as const) {
            nativeTheme.themeSource = theme;
            await captureSplash({
              booted,
              dir,
              name: `art-${shown.replace(':', '-')}`,
              theme,
            });
          }
        }
      } finally {
        nativeTheme.themeSource = themeSource;
        await booted.dispose();
        await host.close();
      }
    });
  });

  for (const value of [undefined, 'shaded'] as const) {
    test(`the splash closes once the workspace window is open (DORIC_SPLASH_ART ${value ?? 'unset'})`, async () => {
      await withSplashArt(value, async () => {
        const host = await startFakeHost(await coreDistribution());
        const booted = await bootPlatform({ host });

        try {
          await booted.window('workspace');
          await until(
            () => booted.platform.splashWindow === undefined || undefined,
            'the splash to close',
            5_000,
          );
        } finally {
          await booted.dispose();
          await host.close();
        }
      });
    });
  }
});
