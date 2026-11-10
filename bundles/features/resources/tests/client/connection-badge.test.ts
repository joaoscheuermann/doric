// The connection badge `<resources-monitor>` draws in the account status slot
// (T-2.3, UR24, spec §2.7): its tone and glyphs without a click, its warning
// thresholds as the polls advance, its accessible description, the popover a
// click opens, the badge without a layout (G10), the glyphs' provenance, and
// the region it registers into (T-2.1).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import type { RegionItem, Services } from 'bundle/contracts';
import { svgMask } from 'desktop/ui/svg-mask';

import type {
  HostResources,
  ProjectResourcesResult,
} from '../../src/client/domain/resources.js';
import * as cloudGlyphs from '../../src/client/monitor/cloud-glyphs.js';
import {
  containerReading,
  hostReading,
  projectId,
  readyProject,
} from '../../stories/support/resources.js';
import { fakeServices } from '../../stories/support/services.js';
import {
  fixtureWorkspace,
  monitorServices,
} from '../../stories/support/workspace.js';
import {
  installWindow,
  press,
  type RenderedMonitor,
  renderMonitor,
} from './support/render-monitor.js';

const MiB = 1024 ** 2;

/** A reading time `n` seconds into a run that started 30 s ago. */
const started = Date.now() - 30_000;
const at = (n: number): string => new Date(started + n * 1000).toISOString();

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** The inline mask a badge span carries for `svg`. */
const maskOf = (svg: string): string =>
  `${svgMask(svg)} center / contain no-repeat`;

const badgeOf = (rendered: RenderedMonitor): HTMLElement => {
  const badge = rendered.root.querySelector<HTMLElement>(
    '[data-slot="connection-badge"]',
  );
  assert.ok(
    badge,
    `No connection badge: ${rendered.root.innerHTML.slice(0, 200)}…`,
  );
  return badge;
};

const spanOf = (badge: HTMLElement, slot: string): HTMLElement => {
  const span = badge.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  assert.ok(span, `No ${slot} span: ${badge.innerHTML}`);
  return span;
};

/** The text the badge's `aria-describedby` points at. */
const descriptionOf = (badge: HTMLElement): string => {
  const id = badge.getAttribute('aria-describedby');
  assert.ok(id, 'The badge has no aria-describedby.');
  return normalized(document.getElementById(id)?.textContent);
};

const popoverHeader = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-slot="resources-popover-header"]');

/**
 * Readings the fixture host answers with, changed by the test between polls.
 * Every reading carries an explicit, distinct `at`.
 */
const liveReadings = (initial: {
  readonly host?: HostResources;
  readonly project?: ProjectResourcesResult;
}) => {
  const current = {
    host: initial.host ?? hostReading({ at: at(0) }),
    project: initial.project ?? readyProject(containerReading({ at: at(0) })),
  };
  return {
    current,
    services: (connected = true): Services =>
      monitorServices({
        workspace: fixtureWorkspace(projectId, { connected }),
        host: () => current.host,
        project: () => current.project,
      }),
  };
};

/** Renders the monitor, runs `body`, and always unmounts it. */
const withMonitor = async (
  services: Services,
  body: (rendered: RenderedMonitor) => Promise<void>,
): Promise<void> => {
  const rendered = await renderMonitor(services);
  try {
    await body(rendered);
  } finally {
    await rendered.cleanup();
  }
};

describe('the connection badge', () => {
  test('is drawn without a click, named and with a cutout over the avatar', async () => {
    const { CLOUD_FILL_SVG } = cloudGlyphs;
    await withMonitor(monitorServices(), async (rendered) => {
      const badge = badgeOf(rendered);
      assert.equal(
        badge.getAttribute('aria-label'),
        'Connection and resources',
      );
      assert.ok(popoverHeader() === null, 'The popover opened by itself.');

      const cutout = spanOf(badge, 'connection-badge-cutout');
      assert.equal(cutout.style.mask, maskOf(CLOUD_FILL_SVG));
      assert.equal(cutout.style.backgroundColor, 'var(--sidebar)');
      assert.ok(cutout.classList.contains('size-3.5'), cutout.className);

      const status = spanOf(badge, 'connection-badge-status');
      for (const name of ['size-2.5', 'top-0.5', 'left-0.5']) {
        assert.ok(status.classList.contains(name), status.className);
      }
    });
  });

  const tones = [
    {
      tone: 'connected',
      connected: true,
      container: () => containerReading({ at: at(0) }),
      glyph: (glyphs: typeof cloudGlyphs) => glyphs.CLOUD_FILL_SVG,
      color: 'var(--paper-green)',
      description: 'Connected',
    },
    {
      tone: 'disconnected',
      connected: false,
      container: () => containerReading({ at: at(0) }),
      glyph: (glyphs: typeof cloudGlyphs) => glyphs.CLOUD_OFF_FILL_SVG,
      color: 'var(--paper-red)',
      description: 'Disconnected',
    },
    {
      tone: 'warning',
      connected: true,
      container: () =>
        containerReading({
          at: at(0),
          memoryUsedBytes: 90 * MiB,
          memoryLimitBytes: 100 * MiB,
        }),
      glyph: (glyphs: typeof cloudGlyphs) => glyphs.CLOUD_FILL_SVG,
      color: 'var(--warning)',
      description: 'Connected · memory high',
    },
  ] as const;

  for (const tone of tones) {
    test(`draws the ${tone.tone} tone with its glyph, color and description`, async () => {
      const glyphs = cloudGlyphs;
      const live = liveReadings({ project: readyProject(tone.container()) });
      await withMonitor(live.services(tone.connected), async (rendered) => {
        const badge = badgeOf(rendered);
        assert.equal(badge.dataset.status, tone.tone);
        const status = spanOf(badge, 'connection-badge-status');
        assert.equal(status.style.mask, maskOf(tone.glyph(glyphs)));
        assert.equal(status.style.backgroundColor, tone.color);
        assert.equal(descriptionOf(badge), tone.description);
      });
    });
  }

  test('warns at 85 % memory, not at 84 %, while the popover stays closed', async () => {
    const live = liveReadings({
      project: readyProject(
        containerReading({
          at: at(0),
          memoryUsedBytes: 84 * MiB,
          memoryLimitBytes: 100 * MiB,
        }),
      ),
    });
    await withMonitor(live.services(), async (rendered) => {
      assert.equal(badgeOf(rendered).dataset.status, 'connected');

      live.current.project = readyProject(
        containerReading({
          at: at(1),
          memoryUsedBytes: 85 * MiB,
          memoryLimitBytes: 100 * MiB,
        }),
      );
      await rendered.advance();

      const badge = badgeOf(rendered);
      assert.ok(popoverHeader() === null, 'The popover is open.');
      assert.equal(badge.dataset.status, 'warning');
      assert.equal(descriptionOf(badge), 'Connected · memory high');
    });
  });

  test('warns on cpu ≥ 90 % only after 3 consecutive readings', async () => {
    const hot = (n: number) => hostReading({ at: at(n), cpuPercent: 95 });
    const live = liveReadings({ host: hot(1) });
    await withMonitor(live.services(), async (rendered) => {
      assert.equal(badgeOf(rendered).dataset.status, 'connected');

      live.current.host = hot(2);
      await rendered.advance();
      assert.equal(
        badgeOf(rendered).dataset.status,
        'connected',
        'Two hot readings warned.',
      );

      live.current.host = hot(3);
      await rendered.advance();
      const badge = badgeOf(rendered);
      assert.equal(badge.dataset.status, 'warning');
      assert.equal(descriptionOf(badge), 'Connected · CPU high');
    });
  });

  test('shows Disconnected without a layout.workspace/v1 provider (G10)', async () => {
    await withMonitor(
      monitorServices({ workspace: null }),
      async (rendered) => {
        const badge = badgeOf(rendered);
        assert.equal(badge.dataset.status, 'disconnected');
        assert.equal(descriptionOf(badge), 'Disconnected');
      },
    );
  });
});

describe('the resources popover', () => {
  test('opens on a click, headed by the connection and the reading age', async () => {
    await withMonitor(monitorServices(), async (rendered) => {
      await press(badgeOf(rendered));
      const header = popoverHeader();
      assert.ok(header, 'The popover did not open.');
      assert.match(
        normalized(header.textContent),
        /^Connected · Updated \d+s ago$/,
      );
    });
  });

  test('is headed "Connected" while no reading has arrived', async () => {
    const services = fakeServices({
      'layout.workspace/v1': fixtureWorkspace(undefined),
      'resources/v1': {
        host: () => new Promise(() => undefined),
        project: () => new Promise(() => undefined),
      },
    });
    await withMonitor(services, async (rendered) => {
      await press(badgeOf(rendered));
      const header = popoverHeader();
      assert.ok(header, 'The popover did not open.');
      assert.equal(normalized(header.textContent), 'Connected');
    });
  });

  test('is headed "Disconnected" when the window is not connected', async () => {
    const live = liveReadings({});
    await withMonitor(live.services(false), async (rendered) => {
      await press(badgeOf(rendered));
      const header = popoverHeader();
      assert.ok(header, 'The popover did not open.');
      assert.equal(normalized(header.textContent), 'Disconnected');
    });
  });
});

describe('the cloud glyphs', () => {
  test('match the stored SHA-256 and length recorded in PROVENANCE.md', async () => {
    const glyphs = cloudGlyphs;
    const provenance = await readFile(
      new URL('../../../PROVENANCE.md', import.meta.url),
      'utf8',
    );
    const rows = new Map(
      [
        ...provenance.matchAll(
          /^\| `(CLOUD_[A-Z_]+_SVG)` +\|.*\| `([0-9a-f]{64})` +\| (\d+) +\|$/gm,
        ),
      ].map((match) => [
        match[1],
        { sha256: match[2], length: Number(match[3]) },
      ]),
    );
    for (const name of ['CLOUD_FILL_SVG', 'CLOUD_OFF_FILL_SVG'] as const) {
      const row = rows.get(name);
      assert.ok(row, `PROVENANCE.md has no row for ${name}.`);
      const value = glyphs[name];
      assert.equal(
        createHash('sha256').update(value, 'utf8').digest('hex'),
        row.sha256,
        `${name} does not hash to its stored SHA-256.`,
      );
      assert.equal(value.length, row.length, `${name} has another length.`);
    }
  });
});

describe('the resources region (T-2.1)', () => {
  test('the activation adds the badge to layout.account.status and nothing to layout.global-footer', async () => {
    installWindow();
    const { activate } = await import('../../src/client/index.js');
    const added: [string, RegionItem][] = [];
    const cleanup = activate({
      services: fakeServices({
        'ui/v1': { define: () => ({ dispose: () => undefined }) },
        'regions/v1': {
          add: (region: string, item: RegionItem) => {
            added.push([region, item]);
            return { dispose: () => undefined };
          },
        },
      }),
    } as unknown as Parameters<typeof activate>[0]);
    try {
      assert.deepEqual(added, [
        [
          'layout.account.status',
          { id: 'resources', tag: 'resources-monitor', order: 10 },
        ],
      ]);
      assert.ok(
        added.every(([region]) => region !== 'layout.global-footer'),
        'An item went into layout.global-footer.',
      );
    } finally {
      cleanup();
    }
  });
});
