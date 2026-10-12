// The splash and recovery surface in a real window: what each state shows,
// its buttons by accessible name, and the `act` round trip to main. Plus the
// minimal test core (core.md): the platform does not depend on the default
// core.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { WebContents } from 'electron';

import { coreDistribution } from '../../doric/tests/support/core';
import {
  type Booted,
  bootPlatform,
  page,
  startFakeHost,
  until,
} from './support/harness';

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

      assert.match(shown, /^Doric/u);
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
        'Return to default composition',
        'Retry',
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
        'Continue without them',
        'Disable probe-new',
        'Retry',
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
