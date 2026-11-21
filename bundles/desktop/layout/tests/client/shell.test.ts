// The workspace shell's frame, read the way a reader meets it. Since bundle
// isolation 4(c) the navigation (the sidebar's content, the Project tabs, the
// Dashboard and the routes) is the `workspace` bundle's: these cases render
// the frame with stand-ins in its slots, and the navigation's cases moved to
// `bundles/desktop/workspace/tests/client/shell.test.ts`.
//
// - T-2.1, S10: after phase 2 removed the global footer, neither the Project
//   view nor the Dashboard renders it, so nothing draws the
//   `layout.global-footer` region.
// - T-2.9: the behaviors that must survive the phase 2 rebuild of the window
//   (spec §2.1–2.6). They name what the reader sees (roles, accessible names,
//   text) and where the window is (its path), never the shell's structure,
//   and they stay out of what the rebuild changes: the Home tab, the global
//   footer, and where `ProjectPanelTabs` and the account status sit.
// - T-1.5 (sidebar alignment §5): an Untitled Thread wears the Untitled icon
//   on its last crumb and its tab; a tab whose Thread the tree lacks keeps
//   the main bubble.
// - T-3.2–T-3.5 (sidebar alignment §9): the column is search, the Thread
//   region (tree scroller, New Thread button), then the registered panes at
//   the bottom; no Threads pane, nothing resizes in the stack.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type CatalogBundle,
  type CatalogSnapshot,
  RegionsV1,
} from 'bundle/contracts';

import { INSET_CARD } from '../../src/client/components/templates/inset-card.js';
import { resetPanel } from '../../src/client/stores/panel.js';
import { workspaceTabsStore } from '../../src/client/stores/workspace-tabs.js';
import {
  LayoutPanelV3,
  LayoutStackV2,
  LayoutTabsV2,
} from '../../src/contracts/index.js';
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

/** The Project and Threads the routes name; the shell reads no record of them. */
const project = {
  id: '6f1c2a3e-4b5d-4e6f-8a7b-1c2d3e4f5a6b',
  name: 'Checkout redesign',
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
};

const thread = (id: string, name: string) => ({
  id,
  projectId: project.id,
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:30:00.000Z',
});

const planThread = thread('3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a', 'Plan');
let rendered: RenderedShell | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** The accessible name of a control: its `aria-label`, else its text. */
const nameOf = (element: Element): string =>
  normalized(element.getAttribute('aria-label') ?? element.textContent);

/** The controls under `root` with `selector` whose accessible name is `name`. */
const named = (
  root: ParentNode,
  selector: string,
  name: string,
): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => nameOf(element) === name,
  );

/** The one control with `selector` named `name`; fails naming what is there. */
const only = (
  root: ParentNode,
  selector: string,
  name: string,
): HTMLElement => {
  const found = named(root, selector, name);
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `Expected one ${selector} named "${name}", found ${found.length}; there are: ${[
      ...root.querySelectorAll(selector),
    ]
      .map(nameOf)
      .join(' | ')}`,
  );
  return first;
};

/** The labelled stand-ins for another bundle's element `tag`. */
const standIns = (root: ParentNode, tag: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-story-placeholder="${tag}"]`),
];

/** Whether `later` comes after `earlier` in the document. */
const follows = (earlier: Node, later: Node): boolean =>
  (earlier.compareDocumentPosition(later) &
    Node.DOCUMENT_POSITION_FOLLOWING) !==
  0;

const click = async (element: HTMLElement): Promise<void> => {
  element.click();
  await settle();
};

/**
 * `fixture` as the frame meets it since bundle isolation 4(c): the stand-ins
 * `workspace` adds to the navigation's slots for its path (the page form's on
 * `/` and `/projects`, the conversation form's elsewhere), and the tab owner
 * `workspace` would name for that path, a Thread id or `project:<id>`.
 */
const shellFixture = (fixture: LayoutFixture): LayoutFixture => {
  const path = fixture.path ?? '/';
  const page = path === '/' || path === '/projects';
  const threadId = /\/threads\/([^/]+)$/.exec(path)?.[1];
  const projectId = /^\/projects\/([^/]+)/.exec(path)?.[1];
  const owner =
    fixture.owner ??
    threadId ??
    (projectId === undefined ? undefined : `project:${projectId}`);
  return {
    ...fixture,
    ...(owner === undefined ? {} : { owner }),
    regions: {
      ...(page ? dashboardStandIns : navigationStandIns),
      ...fixture.regions,
    },
  };
};

/** Renders the frame for `fixture` with the navigation's stand-ins. */
const renderFrame = (fixture: LayoutFixture = {}): Promise<RenderedShell> =>
  renderShell(shellFixture(fixture));

/** The conversation form: a Thread route of `project`. */
const conversationForm = (fixture: LayoutFixture = {}): LayoutFixture =>
  shellFixture({
    path: `/projects/${project.id}/threads/${planThread.id}`,
    ...fixture,
  });

for (const path of [`/projects/${project.id}`, '/projects']) {
  test(`the workspace at ${path} renders no global footer`, async () => {
    rendered = await renderFrame({ path });

    // A count, not the element: inspecting a happy-dom node on failure
    // walks its whole window.
    assert.equal(
      rendered.root.querySelectorAll('[data-slot="workspace-global-footer"]')
        .length,
      0,
      'The global footer is still rendered.',
    );
  });
}

/** The viewer's stand-ins for the files it shows, by what each reads. */
const shownFiles = (workspace: RenderedShell): string[] =>
  standIns(workspace.root, 'files-viewer')
    .filter((element) => element.closest('[hidden]') === null)
    .map((element) => normalized(element.textContent));

// T-2.9.5. The viewer is already open on one file here; opening the first
// file, which adds the viewer's panel to a mounted group, is covered by
// "opening the first file shows the viewer" (render-workspace.ts stands in
// the `offsetLeft` react-resizable-panels orders panels by).
test('a file opened through layout.tabs/v2 gets a viewer tab and shows; closing the last tab removes the viewer', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
    tabs: {
      [`project:${project.id}`]: [
        {
          id: 'file:README.md',
          title: 'README.md',
          tag: 'files-viewer',
          props: { path: 'README.md' },
        },
      ],
    },
  });

  await rendered.services.use(LayoutTabsV2).open({
    id: 'file:src/index.ts',
    title: 'index.ts',
    tag: 'files-viewer',
    props: { path: 'src/index.ts' },
  });
  await settle();

  assert.equal(rendered.errors().length, 0, 'Opening the file failed.');
  const tab = only(rendered.root, '[role="tab"]', 'index.ts');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  const shown = shownFiles(rendered);
  assert.ok(
    shown.length === 1 && shown[0]?.includes('src/index.ts') === true,
    `The viewer does not show src/index.ts alone: ${shown.join(' | ')}`,
  );

  await click(only(rendered.root, 'button', 'Close index.ts'));
  assert.equal(named(rendered.root, '[role="tab"]', 'index.ts').length, 0);
  assert.ok(
    shownFiles(rendered).some((text) => text.includes('README.md')),
    'Closing index.ts did not show README.md again.',
  );

  await click(only(rendered.root, 'button', 'Close README.md'));

  assert.equal(rendered.errors().length, 0, 'Closing the last tab failed.');
  assert.equal(named(rendered.root, '[role="tab"]', 'README.md').length, 0);
  assert.equal(
    standIns(rendered.root, 'files-viewer').length,
    0,
    'The viewer is still there after its last tab closed.',
  );
  // The conversation form stays: its witness is the `shell.sidebar` item,
  // which the frame keeps drawing (the Project view is `workspace`'s, 4(c)).
  assert.equal(
    standIns(rendered.root, 'workspace-sidebar').length,
    1,
    'The conversation form is gone with the viewer.',
  );
});

// T-2.9.8
test('the Screens pane renders below the shell.sidebar items with its items', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });

  const toggle = named(rendered.root, 'button', 'Expand Screens')[0];
  if (toggle !== undefined) await click(toggle);

  const screens = standIns(rendered.root, 'screen-sidebar');
  const [pane] = screens;
  assert.ok(
    screens.length === 1 && pane !== undefined,
    `Expected the Screens pane's items once, found ${screens.length}.`,
  );
  assert.equal(standIns(rendered.root, 'screen-group-action').length, 1);
  const items = standIns(rendered.root, 'workspace-sidebar');
  assert.equal(items.length, 1, 'The shell.sidebar item is not drawn once.');
  assert.ok(
    items.every((item) => follows(item, pane)),
    'The Screens pane is not below the shell.sidebar items.',
  );
});

// Phase 2d-1: the window rebuilt as full-height columns on the sidebar canvas
// (spec §2.1–2.5). These name the hooks the 2d-1 contracts promise: the
// canvas and card classes (T-2.13), the sidebar header's Dashboard button
// (T-2.7), the tab bar's right end, the conversation footer band (T-2.9.9) and
// the invisible viewer handle (G1). happy-dom computes no layout, so a look
// such as "a card" or "no line" is observable here only as the classes that
// draw it.

/** The classes of `classes` that `element` does not carry. */
const missingClasses = (element: Element, classes: string): string[] =>
  classes
    .split(/\s+/)
    .filter((name) => name !== '' && !element.classList.contains(name));

/** The one element under `root` that matches `selector`; fails if not one. */
const single = (root: ParentNode, selector: string): HTMLElement => {
  const found = [...root.querySelectorAll<HTMLElement>(selector)];
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `Expected one ${selector}, found ${found.length}.`,
  );
  return first;
};

/** A viewer tab on README.md, open under the Project, as T-2.9.5 seeds it. */
const withViewer: LayoutFixture = {
  path: `/projects/${project.id}`,
  tabs: {
    [`project:${project.id}`]: [
      {
        id: 'file:README.md',
        title: 'README.md',
        tag: 'files-viewer',
        props: { path: 'README.md' },
      },
    ],
  },
};

const conversationCard = (workspace: RenderedShell): HTMLElement =>
  single(workspace.root, 'main[data-slot="sidebar-inset"]');

// T-2.13
test('the workspace canvas is the sidebar fill', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });

  const layout = single(rendered.root, '[data-slot="workspace-layout"]');
  assert.ok(
    layout.classList.contains('bg-sidebar'),
    `The workspace layout is not on the sidebar canvas: ${layout.className}`,
  );
});

// T-2.13, conversation-footer T-11.1 (D14)
test('the conversation is drawn as an inset card with no bottom padding', async () => {
  const classes = INSET_CARD;
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });

  const card = conversationCard(rendered);
  assert.deepEqual(
    missingClasses(card, classes),
    [],
    'The conversation card lacks INSET_CARD classes.',
  );
  assert.ok(
    card.classList.contains('pb-0'),
    `The conversation card keeps its bottom padding (D14): ${card.className}`,
  );
});

const viewerCard = (workspace: RenderedShell): HTMLElement =>
  single(workspace.root, 'section[aria-label="Viewer"]');

// T-2.13, conversation-footer T-11.2 (D15)
test('an open viewer is drawn as an inset card', async () => {
  const classes = INSET_CARD;
  rendered = await renderFrame(withViewer);

  const viewer = viewerCard(rendered);
  assert.deepEqual(
    missingClasses(viewer, classes),
    [],
    'The viewer card lacks INSET_CARD classes.',
  );
  assert.ok(
    !viewer.classList.contains('pb-0'),
    `The viewer card drops its bottom padding for a file tab (D15): ${viewer.className}`,
  );
});

/**
 * A Thread's tab, as the layout opens a child Thread in the viewer through
 * `layout.tabs/v2` (bundle isolation 4a, T4.5): it asks for an open bottom.
 */
const threadTab = {
  id: 'thread:child',
  title: 'Child',
  tag: 'chat-thread-panel',
  props: { projectId: project.id, threadId: 'child' },
  openBottom: true,
} as const;

// conversation-footer T-11.3 (D15), bundle isolation T4.5: `openBottom`
// decides.
test('the viewer card draws no bottom padding while a tab with openBottom is selected', async () => {
  rendered = await renderFrame(withViewer);

  await rendered.services.use(LayoutTabsV2).open(threadTab);
  await settle();

  assert.equal(rendered.errors().length, 0, 'Opening the Thread tab failed.');
  const viewer = viewerCard(rendered);
  assert.ok(
    viewer.classList.contains('pb-0'),
    `The viewer card keeps its bottom padding under an openBottom tab (D15): ${viewer.className}`,
  );
});

// bundle isolation T4.5: the tag no longer decides.
test('the viewer card keeps its bottom padding for a chat-thread-panel tab without openBottom', async () => {
  rendered = await renderFrame(withViewer);
  await rendered.services.use(LayoutTabsV2).open({
    id: threadTab.id,
    title: threadTab.title,
    tag: threadTab.tag,
    props: threadTab.props,
  });
  await settle();

  assert.equal(rendered.errors().length, 0, 'Opening the Thread tab failed.');
  const viewer = viewerCard(rendered);
  assert.ok(
    !viewer.classList.contains('pb-0'),
    `The viewer card drops its bottom padding without openBottom: ${viewer.className}`,
  );
});

// conversation-footer T-11.4 (D15), bundle isolation 4a change 6: the Thread
// icon element does not decide; only `openBottom` does.
test('the viewer card keeps its bottom padding for another element with the Thread icon', async () => {
  rendered = await renderFrame({
    ...withViewer,
    tabs: {
      [`project:${project.id}`]: [
        {
          id: 'file:README.md',
          title: 'README.md',
          tag: 'files-viewer',
          props: { path: 'README.md' },
          iconTag: 'chat-thread-tab-icon',
        },
      ],
    },
  });

  const viewer = viewerCard(rendered);
  assert.ok(
    !viewer.classList.contains('pb-0'),
    `The viewer card drops its bottom padding for a non-Thread element (D15): ${viewer.className}`,
  );
});

// conversation-footer T-11.5 (D15): the selected tab decides, not any open tab.
test('the viewer card drops its bottom padding only while the openBottom tab is selected', async () => {
  const owner = `project:${project.id}`;
  rendered = await renderFrame(withViewer);
  await rendered.services.use(LayoutTabsV2).open(threadTab);
  await settle();
  assert.ok(
    viewerCard(rendered).classList.contains('pb-0'),
    `The viewer card keeps its bottom padding once the Thread tab is selected (D15): ${viewerCard(rendered).className}`,
  );

  workspaceTabsStore.getState().select(owner, 'file:README.md');
  await settle();

  assert.ok(
    !viewerCard(rendered).classList.contains('pb-0'),
    `The viewer card drops its bottom padding while a file tab is selected (D15): ${viewerCard(rendered).className}`,
  );
});

// bundle isolation T4.5: a v2 tab's trigger draws the element its iconTag
// names, created through `ui/v1` with the tab's props.
test('a layout.tabs/v2 tab with iconTag draws that element in its trigger', async () => {
  rendered = await renderFrame(withViewer);

  await rendered.services.use(LayoutTabsV2).open({
    id: 'probe',
    title: 'Probe',
    tag: 'x-view',
    props: { probe: 1 },
    iconTag: 'x-icon',
    ariaLabel: 'Probe',
  });
  await settle();

  assert.equal(rendered.errors().length, 0, 'Opening the probe tab failed.');
  const tab = only(rendered.root, '[role="tab"]', 'Probe');
  assert.equal(
    standIns(tab, 'x-icon').length,
    1,
    'The trigger does not draw the x-icon element.',
  );
});

// The account status sits in the Files header (contracts 2d-2 §2.3; part 2i,
// S36). The tab bar and its end region are `workspace`'s since step 4(c)
// (`bundles/desktop/workspace/tests/client/shell.test.ts`).
test('Account is in the Files header', async () => {
  rendered = await renderFrame(
    conversationForm({
      regions: {
        'shell.header.actions': [
          { id: 'header-probe', tag: 'header-probe', order: 10 },
        ],
      },
    }),
  );

  only(
    single(rendered.root, '[data-slot="workspace-files-header"]'),
    'button',
    'Account',
  );
});

/**
 * The band's geometry (conversation-footer spec, D2 and D13): the class set
 * both footers carry, the main band here and the viewer band in chat. `py-2`
 * carries the 8 px over and under the row; the height comes from the sheet.
 */
const FOOTER_BAND = [
  'absolute',
  'inset-x-0',
  'bottom-0',
  'flex',
  'items-center',
  'justify-end',
  'gap-1',
  'py-2',
  'pl-2',
  'text-[11px]',
  'font-normal',
].sort();

/** The band's 44 px, as `--shell-conversation-footer-height` states it and the sheet rule reads it (D13). */
const FOOTER_HEIGHT = '2.75rem';

/**
 * The `--shell-conversation-footer-height` an element sets on itself. happy-dom does not
 * always expose a custom property React sets in an inline `style` object
 * through `getPropertyValue`, though it writes it to the attribute.
 */
const ownFooterHeight = (element: Element | null | undefined): string => {
  const style = (element as HTMLElement | null | undefined)?.style;
  const value = style
    ?.getPropertyValue('--shell-conversation-footer-height')
    .trim();
  if (value) return value;
  return (
    /(?:^|;)\s*--shell-conversation-footer-height\s*:\s*([^;]+)/
      .exec(element?.getAttribute('style') ?? '')?.[1]
      ?.trim() ?? ''
  );
};

// G12, T-2.9.9 (band), the layout half of T-2.5, and conversation-footer T-1
test('the conversation footer band is regular weight, borderless and draws shell.conversation.footer', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
    regions: {
      'shell.conversation.footer': [
        { id: 'footer-probe', tag: 'footer-probe', order: 10 },
      ],
    },
  });

  const footer = single(rendered.root, '[data-slot="workspace-footer"]');
  assert.ok(
    footer.classList.contains('font-normal') &&
      !footer.classList.contains('font-light'),
    `The footer band is not regular weight: ${footer.className}`,
  );
  // Figma `99:8035`: the picker and usage labels are `--foreground`; only
  // their "·" separators are muted, and those carry their own class.
  assert.ok(
    !footer.classList.contains('text-muted-foreground'),
    `The footer band mutes its items: ${footer.className}`,
  );
  assert.ok(
    !footer.classList.contains('border-t'),
    'The footer band has a top border.',
  );
  assert.equal(
    standIns(footer, 'footer-probe').length,
    1,
    'The shell.conversation.footer item is not in the footer band.',
  );

  // conversation-footer T-1: the band floats over the bottom of its frame,
  // which tells chat the band's height.
  assert.deepEqual(
    [...footer.classList].sort(),
    FOOTER_BAND,
    'The footer band does not carry the band class set of D13.',
  );
  const frame = footer.parentElement;
  assert.ok(
    frame?.matches('[data-slot="conversation-frame"]') === true,
    `The footer band's parent is not the conversation frame: ${frame?.outerHTML.slice(0, 120)}`,
  );
  assert.ok(
    frame.classList.contains('relative'),
    `The conversation frame is not positioned: ${frame.className}`,
  );
  assert.equal(ownFooterHeight(frame), FOOTER_HEIGHT);
  const conversation = frame.querySelector(
    'section[aria-label="Thread conversation"]',
  );
  assert.ok(
    conversation !== null,
    'The conversation frame does not contain the conversation.',
  );
  assert.ok(
    follows(conversation, footer),
    'The footer band does not follow the conversation.',
  );
  assert.equal(
    frame.lastElementChild === footer,
    true,
    'The footer band is not the conversation frame’s last child.',
  );
});

// conversation-footer T-2: the routed conversation inherits the band's height.
test('the routed conversation stands inside the conversation frame', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}/threads/${planThread.id}`,
  });

  const outlet = single(rendered.root, 'core-outlet');
  assert.ok(
    outlet.closest('[data-slot="conversation-frame"]') !== null,
    'The routed conversation is not inside the conversation frame.',
  );
});

// G1: the handle between the conversation and the viewer is invisible and
// full height. Without layout in happy-dom, its classes are the only witness.
test('the handle before the viewer is a full-height transparent 8 px strip', async () => {
  rendered = await renderFrame(withViewer);

  const card = conversationCard(rendered);
  const [shown] = standIns(rendered.root, 'files-viewer');
  assert.ok(shown !== undefined, 'The viewer is not open.');
  const handle = [
    ...rendered.root.querySelectorAll<HTMLElement>(
      '[data-slot="resizable-handle"]',
    ),
  ]
    .filter((element) => !card.contains(element))
    .filter((element) => follows(card, element) && follows(element, shown))
    .at(-1);
  assert.ok(handle !== undefined, 'No handle between conversation and viewer.');
  assert.ok(
    !handle.classList.contains('-mt-10'),
    'The viewer handle still reaches up into the header row (-mt-10).',
  );
  assert.deepEqual(missingClasses(handle, 'bg-transparent w-2'), []);
});

// Check 2, item 5 (`99:8508`): the viewer opens with the prototype's 448 px
// card and the conversation takes the rest. happy-dom lays nothing out, so the
// panels report a width that adds up to a 1920 px window while this renders;
// react-resizable-panels then sizes each panel as a share of that width.
test('the viewer opens 448 px wide and the conversation takes the rest', async () => {
  // A first render installs happy-dom's window, whose `HTMLElement` this patches.
  (await renderFrame(withViewer)).cleanup();
  const windowWidth = 1920;
  const columns = 4; // sidebar, conversation, viewer, Files
  let owner: object | null = HTMLElement.prototype;
  while (
    owner !== null &&
    Object.getOwnPropertyDescriptor(owner, 'offsetWidth') === undefined
  ) {
    owner = Object.getPrototypeOf(owner);
  }
  const original =
    owner === null
      ? undefined
      : Object.getOwnPropertyDescriptor(owner, 'offsetWidth');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.dataset.panel === undefined ? 0 : windowWidth / columns;
    },
  });
  try {
    rendered = await renderFrame(withViewer);

    const card = conversationCard(rendered);
    const viewer = single(rendered.root, 'section[aria-label="Viewer"]');
    const panelOf = (element: HTMLElement): HTMLElement => {
      const panel = element.closest<HTMLElement>('[data-panel]');
      assert.ok(panel !== null, 'The card is not inside a resizable panel.');
      return panel;
    };
    const width = (element: HTMLElement): number =>
      Math.round((Number(panelOf(element).style.flexGrow) / 100) * windowWidth);
    assert.equal(width(viewer), 448, 'The viewer does not open 448 px wide.');
    assert.equal(
      width(card),
      windowWidth - 280 - 448 - 328,
      'The conversation does not take the rest of the window.',
    );
  } finally {
    delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    if (owner === HTMLElement.prototype && original !== undefined)
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', original);
  }
});

// Contracts 2d-1 §1.8: the stale header organism is gone.
test('the old workspace header organism is deleted', () => {
  // The compiled test runs from `dist-tests/tests/client`; three levels up is
  // the bundle's root in the repository.
  const source = (path: string): string =>
    fileURLToPath(new URL(`../../../src/client/${path}`, import.meta.url));
  assert.ok(
    existsSync(source('components/organisms/workspace-tabs.tsx')),
    'The bundle source is not where this test looks.',
  );

  assert.equal(
    existsSync(source('components/organisms/workspace-header.tsx')),
    false,
    'workspace-header.tsx still exists.',
  );
});

// T-2.9.5 for the first file: before 2d-1, happy-dom's run of
// react-resizable-panels threw "Panel constraints not found" here.
test('opening the first file shows the viewer', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });
  assert.equal(
    rendered.root.querySelectorAll('section[aria-label="Viewer"]').length,
    0,
    'A viewer is open before any file is.',
  );

  await rendered.services.use(LayoutTabsV2).open({
    id: 'file:README.md',
    title: 'README.md',
    tag: 'files-viewer',
    props: { path: 'README.md' },
  });
  await settle();

  assert.deepEqual(
    rendered.errors().map((error) => String(error)),
    [],
    'Opening the first file failed.',
  );
  const viewer = single(rendered.root, 'section[aria-label="Viewer"]');
  assert.ok(
    standIns(viewer, 'files-viewer').some((element) =>
      normalized(element.textContent).includes('README.md'),
    ),
    'The viewer does not show README.md.',
  );
});

// Phase 2d-2: the Files column gets its own header and footer (spec §2.6,
// S9; contracts 2d-2 §2.3–2.6). The header holds the view controls ("Project
// views") and the account status. Part 2i (S36, T-2.17): the column always
// shows; nothing hides or collapses it, and `layout.panel/v3` only selects
// the view it draws.

/** The Project views the app's `shell.panel` region lists (fake-host.ts). */
const panelViews = [
  {
    id: 'files',
    tag: 'files-tree',
    order: 100,
    props: { label: 'Files' },
  },
  {
    id: 'changes',
    tag: 'git-changes',
    order: 200,
    props: { label: 'Changes' },
  },
];

/** A Project view with the panel's views and one `shell.header.actions` item. */
const withHeaderItems = (fixture: LayoutFixture): LayoutFixture => ({
  ...fixture,
  regions: {
    'shell.panel': panelViews,
    'shell.header.actions': [
      { id: 'header-probe', tag: 'header-probe', order: 10 },
    ],
  },
});

const filesHeaders = (workspace: RenderedShell): HTMLElement[] => [
  ...workspace.root.querySelectorAll<HTMLElement>(
    '[data-slot="workspace-files-header"]',
  ),
];

/** Whether `root` holds the "Project views" controls, Files and Changes. */
const holdsProjectViews = (root: ParentNode): boolean =>
  root.querySelectorAll('[aria-label="Project views"]').length === 1 &&
  named(root, '[aria-label]', 'Files').length === 1 &&
  named(root, '[aria-label]', 'Changes').length === 1;

/** Asserts that the window has exactly one "Account" button. */
const oneAccount = (workspace: RenderedShell, when: string): void => {
  const accounts = named(workspace.root, 'button', 'Account');
  assert.equal(
    accounts.length,
    1,
    `${when}: the window has ${accounts.length} "Account" buttons.`,
  );
};

// T-2.5, layout half
test('shell.panel.footer items render in the Files footer, shell.conversation.footer items in the conversation band', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
    regions: {
      'shell.panel.footer': [
        { id: 'panel-footer-probe', tag: 'panel-footer-probe', order: 10 },
      ],
      'shell.conversation.footer': [
        { id: 'footer-probe', tag: 'footer-probe', order: 10 },
      ],
    },
  });

  const filesFooter = single(
    rendered.root,
    '[data-slot="workspace-files-footer"]',
  );
  assert.equal(
    standIns(filesFooter, 'panel-footer-probe').length,
    1,
    'The shell.panel.footer item is not in the Files footer.',
  );
  assert.equal(
    standIns(filesFooter, 'footer-probe').length,
    0,
    'The shell.conversation.footer item is in the Files footer.',
  );
  const band = single(rendered.root, '[data-slot="workspace-footer"]');
  assert.equal(
    standIns(band, 'footer-probe').length,
    1,
    'The shell.conversation.footer item is not in the conversation band.',
  );
  assert.equal(
    standIns(band, 'panel-footer-probe').length,
    0,
    'The shell.panel.footer item is in the conversation band.',
  );
});

// §2.6, S36: the Files column's header
test('the Files header holds the Project views and Account', async () => {
  rendered = await renderFrame(withHeaderItems(conversationForm()));

  const header = single(rendered.root, '[data-slot="workspace-files-header"]');
  assert.ok(
    holdsProjectViews(header),
    `The Files header lacks the Project views; it names: ${[
      ...header.querySelectorAll('[aria-label]'),
    ]
      .map(nameOf)
      .join(' | ')}`,
  );
  only(header, 'button', 'Account');
});

/** The one Files header; fails if the column draws none or several. */
const filesHeader = (workspace: RenderedShell): HTMLElement => {
  const headers = filesHeaders(workspace);
  const [first] = headers;
  assert.ok(
    headers.length === 1 && first !== undefined,
    `Expected one Files header, found ${headers.length}.`,
  );
  return first;
};

/** Whether the Project view control named `name` is the selected one. */
const isSelectedView = (header: HTMLElement, name: string): boolean =>
  only(header, 'button', name).getAttribute('aria-pressed') === 'true';

// Part 2i, T-2.17 (S36): nothing in the window hides the Files column, so no
// files-toggle is drawn and Account stays in the Files header; with a viewer
// tab open too (G17).
for (const [label, fixture] of [
  [
    'without a viewer',
    {
      path: `/projects/${project.id}`,
    },
  ],
  ['with a viewer tab open', withViewer],
] as const) {
  test(`the window draws no files-toggle and one Account button, in the Files header, ${label}`, async () => {
    rendered = await renderFrame(withHeaderItems(fixture));

    assert.equal(
      rendered.root.querySelectorAll('files-toggle').length +
        standIns(rendered.root, 'files-toggle').length,
      0,
      'The window draws a files-toggle.',
    );
    for (const name of ['Hide files', 'Show files']) {
      assert.equal(
        named(rendered.root, 'button', name).length,
        0,
        `The window draws a "${name}" button.`,
      );
    }
    oneAccount(rendered, label);
    only(filesHeader(rendered), 'button', 'Account');
  });
}

// T-2.17, bundle isolation T4.5: `layout.panel/v3` `select` only selects a
// view; the column stays.
test('layout.panel/v3 select selects the view and the Files column stays', async () => {
  rendered = await renderFrame(
    withHeaderItems({
      path: `/projects/${project.id}`,
      panel: { active: 'changes' },
    }),
  );

  assert.ok(isSelectedView(filesHeader(rendered), 'Changes'));

  rendered.services.use(LayoutPanelV3).select('files');
  await settle();

  assert.equal(rendered.errors().length, 0, 'Selecting Files failed.');
  const header = filesHeader(rendered);
  assert.ok(isSelectedView(header, 'Files'), 'Files is not the selected view.');
  assert.ok(!isSelectedView(header, 'Changes'), 'Changes is still selected.');
  assert.equal(standIns(rendered.root, 'files-tree').length, 1);
  assert.equal(standIns(rendered.root, 'git-changes').length, 0);
  single(rendered.root, '[data-slot="workspace-files-footer"]');
});

// bundle isolation T4.5, the last part (step 4(a) change 6): under
// `layout.panel/v3` a window's panel starts with no view selected, so it
// draws none until the files bundle selects Files as it activates.
test('a fresh panel draws no view until layout.panel/v3 selects Files', async () => {
  rendered = await renderFrame(
    withHeaderItems({
      path: `/projects/${project.id}`,
    }),
  );
  resetPanel();
  await settle();

  assert.equal(rendered.errors().length, 0, 'The fresh panel failed.');
  const fresh = filesHeader(rendered);
  assert.ok(!isSelectedView(fresh, 'Files'), 'A fresh panel selects Files.');
  assert.ok(
    !isSelectedView(fresh, 'Changes'),
    'A fresh panel selects Changes.',
  );
  assert.equal(
    standIns(rendered.root, 'files-tree').length +
      standIns(rendered.root, 'git-changes').length,
    0,
    'A fresh panel draws a view.',
  );

  rendered.services.use(LayoutPanelV3).select('files');
  await settle();

  assert.ok(
    isSelectedView(filesHeader(rendered), 'Files'),
    'Files is not the selected view.',
  );
  assert.equal(standIns(rendered.root, 'files-tree').length, 1);
});

// step 4(a) change 6: the layout provides layout.tabs/v2 and layout.panel/v3
// alone; a bundle asking for the old ids finds nothing.
test('the layout provides neither layout.tabs/v1 nor layout.panel/v2', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });
  const services = rendered.services;

  for (const id of ['layout.tabs/v1', 'layout.panel/v2']) {
    assert.throws(
      () => services.use({ id } as unknown as typeof LayoutTabsV2),
      `The layout still provides ${id}.`,
    );
  }
  assert.ok(services.use(LayoutTabsV2));
  assert.ok(services.use(LayoutPanelV3));
});

// bundle isolation T4.5: a shell.panel item's iconTag draws that element as
// the view's icon.
test('a shell.panel item with props.iconTag draws that element as its icon', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
    regions: {
      'shell.panel': [
        {
          id: 'files',
          tag: 'files-tree',
          order: 100,
          props: { label: 'Files', iconTag: 'files-icon-probe' },
        },
        ...panelViews.filter((view) => view.id === 'changes'),
      ],
    },
  });

  const header = filesHeader(rendered);
  const files = only(header, 'button', 'Files');
  assert.equal(
    standIns(files, 'files-icon-probe').length,
    1,
    'The Files view does not draw its iconTag element.',
  );
  assert.equal(
    standIns(only(header, 'button', 'Changes'), 'files-icon-probe').length,
    0,
    'The Changes view draws the Files icon element.',
  );
});

// T-2.17, regression guard: choosing a view in the header keeps the column.
test('selecting the Changes tab draws the Changes view and keeps the Files header and footer', async () => {
  rendered = await renderFrame(
    withHeaderItems({
      path: `/projects/${project.id}`,
    }),
  );

  await click(only(filesHeader(rendered), 'button', 'Changes'));

  assert.equal(rendered.errors().length, 0, 'Selecting Changes failed.');
  assert.ok(
    isSelectedView(filesHeader(rendered), 'Changes'),
    'Changes is not the selected view.',
  );
  assert.equal(standIns(rendered.root, 'git-changes').length, 1);
  assert.equal(standIns(rendered.root, 'files-tree').length, 0);
  single(rendered.root, '[data-slot="workspace-files-footer"]');
});

// T-2.17, UR28: without the files bundle `shell.panel` lists only Changes.
// The panel still selects `files`, which no item has, so it draws no view.
test('without the files bundle the Files header holds the Changes tab and Account only', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
    regions: {
      'shell.panel': panelViews.filter((view) => view.id === 'changes'),
    },
  });

  const header = filesHeader(rendered);
  only(header, 'button', 'Changes');
  only(header, 'button', 'Account');
  for (const name of ['Files', 'Hide files', 'Show files']) {
    assert.equal(
      named(header, 'button, [aria-label]', name).length,
      0,
      `The Files header holds "${name}".`,
    );
  }
  assert.equal(
    standIns(rendered.root, 'git-changes').length +
      standIns(rendered.root, 'files-tree').length,
    0,
    'The panel draws a view no selected item names.',
  );
});

// T-2.17 (S36), guard: the Files column's handle resizes but never collapses.
test('the Files column cannot be collapsed', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });

  const handle = [
    ...rendered.root.querySelectorAll<HTMLElement>(
      '[data-slot="resizable-handle"]',
    ),
  ].at(-1);
  assert.ok(handle !== undefined, 'The Files column has no handle.');
  assert.equal(
    handle.getAttribute('aria-disabled'),
    null,
    'The Files column handle is disabled.',
  );
  filesHeader(rendered);
  single(rendered.root, '[data-slot="workspace-files-footer"]');
});

// Sidebar alignment phase 3 (spec §9, D8–D14): the column is the search
// field, then the Thread region (the tree's scroller and the New Thread
// button), then one group per registered pane at the bottom. There is no
// Threads pane and nothing in the stack resizes. happy-dom lays nothing out,
// so the caps and minimums are observable only as the classes that set them.

/** The sidebar column: the `sidebar` slot that holds the `shell.sidebar` stand-in. */
const projectSidebar = (root: ParentNode): HTMLElement => {
  const sidebar = root
    .querySelector('[data-story-placeholder="workspace-sidebar"]')
    ?.closest<HTMLElement>('[data-slot="sidebar"]');
  assert.ok(sidebar, 'No sidebar holds the shell.sidebar stand-in.');
  return sidebar;
};

/** The stack's pane groups, in document order. */
const paneGroups = (root: ParentNode): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[data-slot="sidebar-pane"]'),
];

// T-3.3
test('the stack has no resize handle and no resizable group', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });
  const sidebar = projectSidebar(rendered.root);

  assert.equal(
    sidebar.querySelectorAll('[data-slot="resizable-handle"]').length,
    0,
    'The sidebar has a resize handle.',
  );
  assert.equal(
    sidebar.querySelectorAll('[data-slot="resizable-panel-group"]').length,
    0,
    'The sidebar has a resizable group.',
  );
});

// T-3.3, T-3.5: the Screens pane sits at the bottom with its header, and
// collapses to it.
test('the Screens pane sits at the bottom with its header, and collapses to it', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });
  const sidebar = projectSidebar(rendered.root);
  const [pane] = paneGroups(sidebar);
  assert.ok(pane, 'The Screens pane has no group.');
  assert.equal(pane.getAttribute('data-pane-id'), 'screen-sidebar');
  const [region] = standIns(sidebar, 'workspace-sidebar');
  assert.ok(region, 'The shell.sidebar item is not drawn.');
  assert.ok(
    !region.contains(pane) && follows(region, pane),
    'The Screens pane is not below the shell.sidebar items.',
  );
  assert.ok(
    [...sidebar.querySelectorAll('*')].every(
      (element) =>
        pane.contains(element) ||
        element.contains(pane) ||
        !follows(pane, element),
    ),
    'Something in the sidebar is below the Screens pane.',
  );
  assert.ok(
    pane.textContent?.includes('Screens'),
    'The Screens pane has no title.',
  );
  assert.equal(standIns(pane, 'screen-group-action').length, 1);

  await click(only(pane, 'button', 'Expand Screens'));
  assert.equal(standIns(pane, 'screen-sidebar').length, 1);

  await click(only(pane, 'button', 'Collapse Screens'));
  assert.equal(
    standIns(rendered.root, 'screen-sidebar').length,
    0,
    'Collapsing Screens keeps its content.',
  );
  assert.ok(
    pane.isConnected && pane.textContent?.includes('Screens'),
    'Collapsing Screens removes its header.',
  );

  await click(only(pane, 'button', 'Expand Screens'));
  assert.equal(standIns(pane, 'screen-sidebar').length, 1);
});

// T-3.4
test('a pane is capped at 40% and keeps its header; the shell.sidebar items stay above it', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });
  const sidebar = projectSidebar(rendered.root);
  const panes = paneGroups(sidebar);
  assert.equal(panes.length, 1, 'The Screens pane has no group.');
  for (const pane of panes)
    assert.deepEqual(missingClasses(pane, 'max-h-[40%] min-h-7'), []);

  const [pane] = panes;
  assert.ok(pane);
  await click(only(pane, 'button', 'Expand Screens'));
  const content = single(pane, '[data-slot="sidebar-group-content"]');
  assert.deepEqual(missingClasses(content, 'min-h-0 overflow-y-auto'), []);

  const [navigation] = standIns(sidebar, 'workspace-sidebar');
  assert.ok(navigation, 'The shell.sidebar stand-in left the column.');
  assert.ok(
    follows(navigation, pane),
    'The pane does not follow the shell.sidebar items.',
  );
});

// Sidebar alignment (spec: docs/designs/sidebar-alignment.md §9.5,
// pane headers): the pane header's action is revealed
// only while the header is hovered or holds focus, as a Thread row's are.
test('a pane header reveals its action only while it is hovered or holds focus', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });
  const [pane] = paneGroups(projectSidebar(rendered.root));
  assert.ok(pane, 'The Screens pane has no group.');
  const label = single(pane, '[data-slot="sidebar-group-label"]');
  const header = label.parentElement;
  assert.ok(header !== null, 'The pane label has no header wrapper.');
  assert.deepEqual(
    missingClasses(header, 'group/pane-header relative shrink-0'),
    [],
  );

  const [action] = standIns(pane, 'screen-group-action');
  assert.ok(action, 'The Screens pane has no header action.');
  // The reveal sits on the action's own wrapper, a child of the header; the
  // element host (`ElementHost`, `display: contents`) may sit between them.
  let wrapper: HTMLElement | null = action.parentElement;
  while (
    wrapper !== null &&
    wrapper !== header &&
    wrapper.parentElement !== header
  )
    wrapper = wrapper.parentElement;
  assert.ok(
    wrapper !== null && wrapper !== header,
    'The header action is not inside the pane header.',
  );
  assert.deepEqual(
    missingClasses(
      wrapper,
      'pointer-events-none opacity-0 group-hover/pane-header:opacity-100 group-hover/pane-header:pointer-events-auto group-focus-within/pane-header:opacity-100 group-focus-within/pane-header:pointer-events-auto',
    ),
    [],
    'The header action is not revealed on the header hover or focus.',
  );
  assert.equal(wrapper.parentElement, header);
});

// T-3.5
test('layout.stack/v2 lists only the registered panes, with no Threads pane', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}`,
  });

  assert.deepEqual(
    rendered.services
      .use(LayoutStackV2)
      .panes()
      .map((pane: { readonly id: string }) => pane.id),
    ['screen-sidebar'],
  );
});

// O2
test('layout/contracts names the five new shell slots', async () => {
  const contracts: Readonly<Record<string, unknown>> = await import(
    '../../src/contracts/index.js'
  );
  assert.deepEqual(
    {
      SHELL_SIDEBAR: contracts.SHELL_SIDEBAR,
      SHELL_SIDEBAR_FOOTER: contracts.SHELL_SIDEBAR_FOOTER,
      SHELL_TITLEBAR_TABS: contracts.SHELL_TITLEBAR_TABS,
      SHELL_PAGE: contracts.SHELL_PAGE,
      SHELL_WINDOW_ACTIONS: contracts.SHELL_WINDOW_ACTIONS,
    },
    {
      SHELL_SIDEBAR: 'shell.sidebar',
      SHELL_SIDEBAR_FOOTER: 'shell.sidebar.footer',
      SHELL_TITLEBAR_TABS: 'shell.titlebar.tabs',
      SHELL_PAGE: 'shell.page',
      SHELL_WINDOW_ACTIONS: 'shell.window.actions',
    },
  );
});

// T4.2
test('T4.2: the frame is in the page form exactly while shell.page holds an item', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}/threads/${planThread.id}`,
  });
  const workspace = rendered;
  const form = () => ({
    outlets: workspace.root.querySelectorAll('core-outlet').length,
    pageItems: standIns(workspace.root, 'page-probe').length,
  });
  assert.deepEqual(
    form(),
    { outlets: 1, pageItems: 0 },
    'A Thread route with shell.page empty is not in the conversation form.',
  );

  const probe = workspace.services
    .use(RegionsV1)
    .add('shell.page', { id: 'page-probe', tag: 'page-probe' });
  await settle();
  assert.deepEqual(
    form(),
    { outlets: 0, pageItems: 1 },
    'With an item in shell.page the frame is not in the page form.',
  );

  probe.dispose();
  await settle();
  assert.deepEqual(
    form(),
    { outlets: 1, pageItems: 0 },
    'With shell.page emptied again the frame is not in the conversation form.',
  );
});

// T4.6 ------------------------------------------------------------------------

const quarantined: CatalogSnapshot = (() => {
  const bundles: readonly CatalogBundle[] = [
    { id: 'layout', version: '4.7.0', state: 'active', reasons: [] },
    {
      id: 'terminal',
      version: '2.0.1',
      state: 'quarantined',
      reasons: [{ code: 'activate_failed', message: 'activate() threw: boom' }],
    },
  ];
  return {
    generation: 1,
    composition: {
      core: 'core',
      enabled: bundles.map(({ id }) => id),
      providers: {},
    },
    bundles,
    order: bundles.map(({ id }) => id),
    contracts: [],
  };
})();

/** The window's one quarantine notice. */
const quarantineNotice = (root: ParentNode): HTMLElement =>
  single(root, '[data-slot="error-notice"][data-tone="warning"]');

const footerProbe = { id: 'footer-probe', tag: 'footer-probe' };
const sidebarProbe = { id: 'sidebar-probe', tag: 'sidebar-probe' };

// T4.6
test('T4.6: in the conversation form the notice follows the shell.sidebar items and the last stack pane, and precedes shell.sidebar.footer, with mx-1.5', async () => {
  rendered = await renderFrame({
    path: `/projects/${project.id}/threads/${planThread.id}`,
    catalog: quarantined,
    regions: { 'shell.sidebar.footer': [footerProbe] },
  });
  const notice = quarantineNotice(rendered.root);
  const [search] = standIns(rendered.root, 'workspace-sidebar');
  assert.ok(search, 'The shell.sidebar item is not drawn.');
  const lastPane = paneGroups(rendered.root).at(-1);
  assert.ok(lastPane !== undefined, 'The fixture shows no stack pane.');
  const [footer] = standIns(rendered.root, 'footer-probe');
  assert.ok(footer, 'The shell.sidebar.footer item is not drawn.');

  assert.ok(follows(search, notice), 'The notice precedes shell.sidebar.');
  assert.ok(
    !lastPane.contains(notice) && follows(lastPane, notice),
    'The notice does not follow the last stack pane.',
  );
  assert.ok(
    follows(notice, footer),
    'The notice does not precede shell.sidebar.footer.',
  );
  assert.ok(
    notice.classList.contains('mx-1.5'),
    `The notice lacks mx-1.5: ${notice.className}`,
  );
});

// T4.6
test('T4.6: in the page form the notice follows the shell.sidebar items and precedes shell.sidebar.footer, with mx-2', async () => {
  rendered = await renderFrame({
    path: '/projects',
    catalog: quarantined,
    regions: {
      'shell.sidebar': [sidebarProbe],
      'shell.sidebar.footer': [footerProbe],
    },
  });
  const notice = quarantineNotice(rendered.root);
  const [sidebarItem] = standIns(rendered.root, 'sidebar-probe');
  assert.ok(sidebarItem, 'The shell.sidebar item is not drawn.');
  const [footer] = standIns(rendered.root, 'footer-probe');
  assert.ok(footer, 'The shell.sidebar.footer item is not drawn.');

  // The Dashboard's search and "All settings" are drawn inside these two
  // items by `workspace` and `settings` (bundle isolation 4(c)).
  assert.ok(
    follows(sidebarItem, notice),
    'The notice precedes the shell.sidebar item.',
  );
  assert.ok(
    follows(notice, footer),
    'The notice follows the shell.sidebar.footer item.',
  );
  assert.ok(
    notice.classList.contains('mx-2'),
    `The notice lacks mx-2: ${notice.className}`,
  );
});
