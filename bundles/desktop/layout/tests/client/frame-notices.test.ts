// The frame's own notices (error messages spec §7.2, §8; T-33, T-34), with
// stand-ins in the navigation's slots. Since bundle isolation 4(c) the
// navigation is the `workspace` bundle's; these cases moved here from its
// `tests/client/workspace-errors.test.ts`, which keeps the workspace notices:
// - the window's quarantine notice sits at the bottom of the frame's left
//   sidebar in both forms — the conversation form's sidebar content ends with
//   it, after the stack panes; the page form draws it directly above the
//   `shell.sidebar.footer` items — and nowhere else (T-33);
// - `ElementHost` shows a compact notice when `ui.create` throws for a stack
//   pane's action element (T-34);
// - the frame's `<Toaster>` draws the toasts any bundle posts through
//   `desktop/ui/sonner`, as the workspace's archive toast (AC17) is drawn.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  type CatalogBundle,
  type CatalogSnapshot,
  UiV1,
} from 'bundle/contracts';

import type { LayoutFixture } from '../../stories/support/layout-host.js';
import {
  dashboardStandIns,
  navigationStandIns,
} from '../../stories/support/tabs.js';
import {
  type RenderedShell,
  renderShell,
  settle,
} from './support/render-shell.js';

const projectId = '6f1c2a3e-4b5d-4e6f-8a7b-1c2d3e4f5a6b';
const threadId = '3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a';
const threadPath = `/projects/${projectId}/threads/${threadId}`;
const projectPath = `/projects/${projectId}`;

let rendered: RenderedShell | undefined;
const restores: (() => void)[] = [];

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  for (const restore of restores.splice(0).reverse()) restore();
  document.body.replaceChildren();
});

/**
 * The frame at `path` with the stand-ins `workspace` adds there (the page
 * form's on `/projects`, the conversation form's elsewhere) and the tab owner
 * it would name.
 */
const renderFrame = async (
  path: string,
  fixture: LayoutFixture = {},
): Promise<RenderedShell> => {
  const page = path === '/' || path === '/projects';
  const owner = path === threadPath ? threadId : `project:${projectId}`;
  rendered = await renderShell({
    path,
    ...(page ? {} : { owner }),
    ...fixture,
    regions: page ? dashboardStandIns : navigationStandIns,
  });
  return rendered;
};

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

const nameOf = (element: Element): string =>
  normalized(element.getAttribute('aria-label') ?? element.textContent);

const only = (
  root: ParentNode,
  selector: string,
  name: string,
): HTMLElement => {
  const found = [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => nameOf(element) === name,
  );
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `Expected one ${selector} named "${name}", found ${found.length}.`,
  );
  return first;
};

const follows = (earlier: Node, later: Node): boolean =>
  (earlier.compareDocumentPosition(later) &
    Node.DOCUMENT_POSITION_FOLLOWING) !==
  0;

const click = async (element: HTMLElement): Promise<void> => {
  element.click();
  await settle();
};

/** The labelled stand-in for another bundle's element `tag`. */
const standIn = (root: ParentNode, tag: string): HTMLElement => {
  const found = [
    ...root.querySelectorAll<HTMLElement>(`[data-story-placeholder="${tag}"]`),
  ];
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `Expected the stand-in ${tag} once, found ${found.length}.`,
  );
  return first;
};

/** The frame's left sidebar: the one that holds the `shell.sidebar` items. */
const frameSidebar = (shell: RenderedShell): HTMLElement => {
  const sidebar = standIn(shell.root, 'workspace-sidebar').closest<HTMLElement>(
    '[data-slot="sidebar"]',
  );
  assert.ok(sidebar, 'The shell.sidebar items are in no sidebar.');
  return sidebar;
};

const NOTICE = '[data-slot="error-notice"]';

/** Every error notice under `root`, in document order. */
const notices = (root: ParentNode): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(NOTICE),
];

/** The notice's title: the element its `aria-labelledby` names. */
const titleOf = (notice: HTMLElement): string => {
  const id = notice.getAttribute('aria-labelledby');
  assert.ok(id, 'The notice names no title.');
  return normalized(document.getElementById(id)?.textContent);
};

/** The quarantine notices under `root`: the notices in the warning tone. */
const quarantineNotices = (root: ParentNode): HTMLElement[] =>
  notices(root).filter((notice) => notice.dataset.tone === 'warning');

/** The notices in any other tone. */
const otherNotices = (root: ParentNode): HTMLElement[] =>
  notices(root).filter((notice) => notice.dataset.tone !== 'warning');

/** The labelled buttons of a notice's first row: Retry, Copy details. */
const iconButtons = (notice: HTMLElement): string[] =>
  [...notice.querySelectorAll<HTMLElement>('button[aria-label]')].map(nameOf);

/** Opens the notice's details and answers their text. */
const detailsOf = async (notice: HTMLElement): Promise<string> => {
  await click(only(notice, 'button', 'Details'));
  const details = notice.querySelector('pre[aria-label="Error details"]');
  assert.ok(details, 'The notice shows no details.');
  return details.textContent ?? '';
};

/** Silences `console.error` until the test ends (`ElementHost` logs a failure). */
const quietConsoleError = (): void => {
  const original = console.error;
  console.error = () => undefined;
  restores.push(() => {
    console.error = original;
  });
};

// T-33: the quarantine notice -------------------------------------------------

const catalogBundle = (
  id: string,
  version: string,
  state: CatalogBundle['state'],
  reasons: CatalogBundle['reasons'] = [],
): CatalogBundle => ({ id, version, state, reasons });

const catalogOf = (bundles: readonly CatalogBundle[]): CatalogSnapshot => ({
  generation: 1,
  composition: {
    core: 'core',
    enabled: bundles.map(({ id }) => id),
    providers: {},
  },
  bundles,
  order: bundles.map(({ id }) => id),
  contracts: [],
});

const twoQuarantined = catalogOf([
  catalogBundle('layout', '3.1.0', 'active'),
  catalogBundle('files', '1.4.0', 'quarantined', [
    {
      code: 'incompatible_version',
      message:
        'requires runtime.threads/v1@^1.8.0; active 1.7.0 (runtime 2.7.0)',
      contract: 'runtime.threads/v1',
    },
  ]),
  catalogBundle('usage', '1.0.0', 'disabled'),
  catalogBundle('terminal', '2.0.1', 'quarantined', [
    { code: 'activate_failed', message: 'activate() threw: boom' },
  ]),
]);

/** Checks the one quarantine notice's look and answers it. */
const assertQuarantineNotice = (shell: RenderedShell): HTMLElement => {
  const found = quarantineNotices(document);
  const [notice] = found;
  assert.ok(
    found.length === 1 && notice !== undefined,
    `Expected one quarantine notice in the window, found ${found.length}.`,
  );
  assert.ok(shell.root.contains(notice));
  assert.equal(titleOf(notice), "2 extensions couldn't start");
  assert.equal(notice.dataset.variant, 'block');
  assert.equal(notice.getAttribute('role'), 'group');
  assert.equal(
    notice.querySelectorAll('svg.lucide-package-x').length,
    1,
    'The notice does not show the PackageX icon.',
  );
  assert.deepEqual(iconButtons(notice), ['Copy details']);
  assert.ok(
    normalized(notice.textContent).includes('Turned off: files, terminal.'),
    `The notice does not name the bundles: ${normalized(notice.textContent)}`,
  );
  // No ElementHost and no region draws one: every notice the window shows
  // here is this one.
  assert.deepEqual(notices(document), [notice]);
  return notice;
};

describe('the quarantine notice (T-33)', () => {
  test("the conversation form shows it once, as the sidebar content's last child, after the stack panes", async () => {
    const shell = await renderFrame(threadPath, { catalog: twoQuarantined });

    const notice = assertQuarantineNotice(shell);
    const content = frameSidebar(shell).querySelector(
      '[data-slot="sidebar-content"]',
    );
    assert.ok(content, 'The sidebar has no content.');
    assert.equal(content.lastElementChild, notice);
    const panes = [...content.querySelectorAll('[data-pane-id]')];
    assert.ok(panes.length > 0, 'The fixture shows no stack pane.');
    for (const pane of panes) {
      assert.ok(follows(pane, notice), 'A stack pane follows the notice.');
    }

    const details = await detailsOf(notice);
    assert.ok(details.includes('Code: bundle_quarantined'), details);
    assert.ok(
      details.includes(
        'files@1.4.0: requires runtime.threads/v1@^1.8.0; active 1.7.0 (runtime 2.7.0) (runtime.threads/v1)',
      ),
      details,
    );
    assert.ok(
      details.includes('terminal@2.0.1: activate() threw: boom'),
      details,
    );
    assert.ok(!details.includes('usage@'), 'A disabled bundle is listed.');
    assert.ok(!details.includes('Time:'), 'The details state a time.');
  });

  test('the page form shows it once in the sidebar, directly above the shell.sidebar.footer items', async () => {
    const shell = await renderFrame('/projects', { catalog: twoQuarantined });

    const notice = assertQuarantineNotice(shell);
    assert.ok(
      frameSidebar(shell).contains(notice),
      'The notice is not in the sidebar.',
    );
    // The frame draws the notice, then the slot `shell.sidebar.footer`, which
    // holds the Dashboard's footer (with `settings`' "All settings").
    const footer = notice.nextElementSibling;
    const item = standIn(shell.root, 'workspace-sidebar-footer');
    assert.ok(
      footer !== null && (footer === item || footer.contains(item)),
      'The element below the notice does not hold the shell.sidebar.footer item.',
    );
  });

  test('without a quarantined bundle, or without the catalog, neither form shows it', async () => {
    const healthy = catalogOf([
      catalogBundle('layout', '3.1.0', 'active'),
      catalogBundle('usage', '1.0.0', 'disabled'),
    ]);
    for (const path of [threadPath, '/projects']) {
      const withCatalog = await renderFrame(path, { catalog: healthy });
      assert.deepEqual(quarantineNotices(withCatalog.root), [], path);
      withCatalog.cleanup();

      const withoutCatalog = await renderFrame(path);
      assert.deepEqual(quarantineNotices(withoutCatalog.root), [], path);
      withoutCatalog.cleanup();
    }
  });
});

// The window's toaster --------------------------------------------------------

test('a toast posted through desktop/ui/sonner shows in the frame, in both forms', async () => {
  for (const path of [threadPath, '/projects']) {
    const shell = await renderFrame(path);
    const { toast } = await import('desktop/ui/sonner');
    toast('Probe posted', { description: path });
    await settle();

    const shown = [...shell.root.querySelectorAll('[data-sonner-toast]')].map(
      (element) => normalized(element.textContent),
    );
    assert.deepEqual(shown, [`Probe posted${path}`], path);
    toast.dismiss();
    await settle();
    shell.cleanup();
  }
});

// T-34: ElementHost -----------------------------------------------------------

/** The tag of the stack pane's action element, which `ElementHost` mounts. */
const PANE_ACTION = 'screen-group-action';

describe('ElementHost (T-34)', () => {
  test('when ui.create throws it shows a compact, announced "View failed to open" naming the element', async () => {
    quietConsoleError();
    const shell = await renderFrame(projectPath);
    const ui = shell.services.use(UiV1) as unknown as {
      create: (tag: string, props?: unknown) => unknown;
    };
    const create = ui.create;
    ui.create = (tag, props) => {
      if (tag === PANE_ACTION) throw new Error('define() was never called');
      return create(tag, props);
    };
    restores.push(() => {
      ui.create = create;
    });
    await shell.remount();

    const found = otherNotices(shell.root);
    const [notice] = found;
    assert.ok(
      found.length === 1 && notice !== undefined,
      `Expected one notice, found ${found.length}.`,
    );
    assert.equal(titleOf(notice), 'View failed to open');
    assert.equal(notice.dataset.variant, 'compact');
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.ok(
      notice.closest('[data-pane-id]'),
      'The notice is not where the element would be.',
    );
    assert.deepEqual(
      [...notice.querySelectorAll<HTMLElement>('button')]
        .map(nameOf)
        .filter((name) => name === 'Retry'),
      [],
      'The notice offers Retry.',
    );
    const details = await detailsOf(notice);
    assert.ok(details.includes(`Element: ${PANE_ACTION}`), details);
  });

  test('an element that is answered, or answered as <core-unavailable>, shows no notice', async () => {
    const shell = await renderFrame(projectPath, {
      catalog: catalogOf([
        catalogBundle('screen', '1.0.0', 'quarantined', [
          { code: 'activate_failed', message: 'activate() threw: boom' },
        ]),
      ]),
    });
    assert.deepEqual(otherNotices(shell.root).map(titleOf), []);

    const ui = shell.services.use(UiV1) as unknown as {
      create: (tag: string, props?: unknown) => unknown;
    };
    const create = ui.create;
    ui.create = (tag, props) => {
      if (tag !== PANE_ACTION) return create(tag, props);
      const unavailable = document.createElement('core-unavailable');
      unavailable.hidden = true;
      return unavailable;
    };
    restores.push(() => {
      ui.create = create;
    });
    await shell.remount();

    const pane = shell.root.querySelector('[data-pane-id]');
    assert.ok(pane, 'The fixture shows no stack pane.');
    assert.equal(
      pane.querySelectorAll('core-unavailable').length,
      1,
      'The unavailable element is not mounted.',
    );
    assert.deepEqual(notices(pane), []);
    assert.deepEqual(otherNotices(shell.root).map(titleOf), []);
  });
});
