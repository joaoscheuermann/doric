// The sidebar's Chat and Archived tabs in the rendered window
// (docs/designs/thread-archive.md §10.2-§10.7, §11; T-27; AC14-AC20, AC23):
// - two icon-only sidebar tabs, Chat (open) and Archived, named and with the
//   tooltips "Chat" and "Archived", no counter; the search filters the open
//   tab's tree and switching tabs keeps the query;
// - Chat hides archived Threads but an archived ancestor of a Thread in Chat,
//   drawn dimmed with the "Archived" mark, no hover action, and a menu of
//   Open, Copy thread ID and Restore thread;
// - Archived groups the archived Threads under Today / Last 7 days / Older,
//   with their non-archived ancestors as inert, dimmed context rows;
// - hover Archive, the toast "Thread archived" with Undo, hover Restore and
//   Delete, hover Unpin, the pin mark and the menu's Pin / Unpin;
// - Delete from Archived names the descendants still in Chat;
// - an archived Thread stays selectable and its route resolves.
// happy-dom draws no hover: a hover action is read as the button its row
// holds, as `thread-rows.test.ts` reads the plus.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { NavigationV1, ref } from 'bundle/contracts';

import type { ThreadsHost } from '../../src/client/api/host.js';
import type { Project, Thread } from '../../src/client/domain/workspace.js';
import type { LayoutFixture } from '../../stories/support/layout-host.js';
import {
  type RenderedWorkspace,
  renderWorkspace,
  settle,
} from './support/render-workspace.js';

const project: Project = {
  id: '6f1c2a3e-4b5d-4e6f-8a7b-1c2d3e4f5a6b',
  name: 'Checkout redesign',
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
};

const day = 24 * 60 * 60 * 1000;
// Read when a test builds its fixture, so "today" is the run's local today.
const archivedToday = (): string => new Date().toISOString();
const archivedThisWeek = (): string =>
  new Date(Date.now() - 3 * day).toISOString();
const archivedLongAgo = (): string =>
  new Date(Date.now() - 30 * day).toISOString();

const thread = (
  id: string,
  name: string,
  fields: Partial<Thread> = {},
): Thread => ({
  id,
  projectId: project.id,
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:30:00.000Z',
  ...fields,
});

const ids = {
  plan: '3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a',
  validate: '2c4e6a8b-0d1f-4a3c-8e5b-7d9f1b3c5e7a',
  research: '7e9f1a3b-5c7d-4e9f-a1b3-c5d7e9f1a3b5',
  compare: '8b0d2f4a-6c8e-4a0c-9e2b-4d6f8a0c2e4b',
  spec: '5a7c9e1b-3d5f-4b7d-9f1a-3c5e7a9b1d3f',
  notes: '1f3b5d7a-9c1e-4f3b-8d5a-7c9e1b3d5f7a',
  findings: '9c1e3a5b-7d9f-4b1d-8f3a-5c7e9a1b3d5f',
  pinned: '4e6a8c0b-2d4f-4a6c-8e0a-2c4e6a8c0b2d',
  running: '6b8d0f2a-4c6e-4b8d-9f2a-4c6e8b0d2f4a',
  benchmark: 'a3c5e7b9-1d3f-4a5c-8e7b-9d1f3a5c7e9b',
} as const;

/**
 * The tree the tests read, in host order:
 * - Plan the checkout (main, idle) and its archived agent thread Validate
 *   inputs (today);
 * - Research payments (main, archived today) and its sub-thread Compare
 *   providers, still in Chat;
 * - Draft the spec (archived three days ago);
 * - Old notes and its child Old findings (archived together a month ago);
 * - Pinned idea (pinned) and Run the build (running).
 */
const fixtureThreads = (): Thread[] => {
  const today = archivedToday();
  const longAgo = archivedLongAgo();
  return [
    thread(ids.plan, 'Plan the checkout'),
    thread(ids.validate, 'Validate inputs', {
      parentThreadId: ids.plan,
      origin: 'agent',
      archivedAt: today,
    }),
    thread(ids.research, 'Research payments', { archivedAt: today }),
    thread(ids.compare, 'Compare providers', {
      parentThreadId: ids.research,
      origin: 'user',
    }),
    thread(ids.spec, 'Draft the spec', { archivedAt: archivedThisWeek() }),
    thread(ids.notes, 'Old notes', { archivedAt: longAgo }),
    thread(ids.findings, 'Old findings', {
      parentThreadId: ids.notes,
      origin: 'user',
      archivedAt: longAgo,
    }),
    thread(ids.pinned, 'Pinned idea', { pinned: true }),
    thread(ids.running, 'Run the build', {
      state: 'running',
      activePromptId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      executionStartedAt: '2026-11-09T09:58:00.000Z',
    }),
  ];
};

const threadPathOf = (id: string): string =>
  `/projects/${project.id}/threads/${id}`;

let rendered: RenderedWorkspace | undefined;

afterEach(async () => {
  rendered?.cleanup();
  rendered = undefined;
  // sonner keeps its toasts in a module store across mounts.
  const { toast } = await import('desktop/ui/sonner');
  toast.dismiss();
  await settle();
  document.body.replaceChildren();
});

/** The workspace at Pinned idea, with every branch open (Threads start open). */
const render = async (
  fixture: LayoutFixture = {},
): Promise<RenderedWorkspace> => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    threads: fixtureThreads(),
    path: threadPathOf(ids.pinned),
    ...fixture,
  });
  return rendered;
};

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

/** The host's `runtime.threads/v1`, which a test may wrap to see what it was asked. */
const threadsOf = (workspace: RenderedWorkspace): Mutable<ThreadsHost> =>
  workspace.services.use(ref<Mutable<ThreadsHost>>('runtime.threads/v1'));

const pathOf = (workspace: RenderedWorkspace): string | undefined =>
  workspace.services.use(NavigationV1).current()?.path;

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

const nameOf = (element: Element): string =>
  normalized(element.getAttribute('aria-label') ?? element.textContent);

const named = (
  root: ParentNode,
  selector: string,
  name: string,
): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => nameOf(element) === name,
  );

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

const click = async (element: HTMLElement): Promise<void> => {
  element.click();
  await settle();
};

/** The viewer tab `id` (`thread:<id>` for a Thread), as the layout opens a child. */
const viewerTab = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    `[aria-label="Files, changes, terminals and threads"] [data-tab-id="${id}"]`,
  );
  assert.ok(found, `No viewer tab ${id}.`);
  return found;
};

/** The sidebar's tab trigger named `name`. */
const sidebarTab = (workspace: RenderedWorkspace, name: string): HTMLElement =>
  only(workspace.root, '[role="tab"]', name);

const openTab = async (
  workspace: RenderedWorkspace,
  name: 'Chat' | 'Archived',
): Promise<void> => {
  await click(sidebarTab(workspace, name));
  assert.equal(
    sidebarTab(workspace, name).getAttribute('aria-selected'),
    'true',
    `The ${name} tab did not open.`,
  );
};

/** The names the Thread tree draws, top to bottom. */
const treeNames = (workspace: RenderedWorkspace): string[] =>
  [...workspace.root.querySelectorAll('[role="treeitem"]')].map((item) =>
    normalized(item.textContent),
  );

const SECTION_LABELS = new Set(['Today', 'Last 7 days', 'Older']);

/** The Archived tab top to bottom: its section headers and its rows' names. */
const archivedOutline = (workspace: RenderedWorkspace): string[] =>
  [
    ...workspace.root.querySelectorAll<HTMLElement>(
      '[role="presentation"], [role="treeitem"]',
    ),
  ]
    .filter(
      (element) =>
        element.getAttribute('role') === 'treeitem' ||
        SECTION_LABELS.has(normalized(element.textContent)),
    )
    .map((element) => normalized(element.textContent));

/** Every tree row: the `group/tree-row` element around a treeitem. */
const rows = (workspace: RenderedWorkspace): HTMLElement[] =>
  [...workspace.root.querySelectorAll<HTMLElement>('div')].filter(
    (element) =>
      element.classList.contains('group/tree-row') &&
      element.querySelector('[role="treeitem"]') !== null,
  );

/** The tree row whose treeitem reads `name`; fails unless there is one. */
const row = (workspace: RenderedWorkspace, name: string): HTMLElement => {
  const found = rows(workspace).filter(
    (element) =>
      normalized(element.querySelector('[role="treeitem"]')?.textContent) ===
      name,
  );
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `Expected one tree row named "${name}", found ${found.length}; the tree reads ${treeNames(workspace).join(' | ')}.`,
  );
  return first;
};

const treeitem = (element: HTMLElement): HTMLElement => {
  const item = element.querySelector<HTMLElement>('[role="treeitem"]');
  assert.ok(item !== null, 'The row has no treeitem.');
  return item;
};

/** The labels of the buttons a row holds besides its treeitem. */
const rowActions = (element: HTMLElement): string[] =>
  [...element.querySelectorAll<HTMLElement>('button')]
    .map((button) => button.getAttribute('aria-label') ?? '')
    .filter((label) => label !== '')
    .sort();

const action = (element: HTMLElement, label: string): HTMLElement => {
  const found = element.querySelector<HTMLElement>(
    `button[aria-label="${label}"]`,
  );
  assert.ok(
    found !== null,
    `The row has no "${label}" action; it has ${rowActions(element).join(' | ')}.`,
  );
  return found;
};

/** The row's marks: the elements named "Pinned" or "Archived" that are not buttons. */
const marks = (element: HTMLElement): string[] =>
  [...element.querySelectorAll<Element>('[aria-label]')]
    .filter((node) => node.tagName.toLowerCase() !== 'button')
    .map((node) => node.getAttribute('aria-label') ?? '')
    .filter((label) => label === 'Pinned' || label === 'Archived');

/** Whether anything in the row's treeitem is drawn at 50% opacity. */
const dimmed = (element: HTMLElement): boolean =>
  [treeitem(element), ...treeitem(element).querySelectorAll('*')].some((node) =>
    node.classList.contains('opacity-50'),
  );

/** Right-clicks `target`, as a reader opens its context menu. */
const openMenu = async (target: Element): Promise<void> => {
  target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    }),
  );
  await settle();
};

const menuEntries = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-slot="context-menu-content"] [role="menuitem"]',
  ),
];

const menuLabels = (): string[] =>
  menuEntries().map((entry) => normalized(entry.textContent));

const pick = async (label: string): Promise<void> => {
  const entry = menuEntries().find(
    (item) => normalized(item.textContent) === label,
  );
  assert.ok(
    entry,
    `No entry "${label}"; the menu holds ${menuLabels().join(' | ')}`,
  );
  await click(entry);
};

/** Types `text` into `input` as the reader does: React sees the new value. */
const type = async (input: HTMLInputElement, text: string): Promise<void> => {
  input.focus();
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
};

const search = (workspace: RenderedWorkspace): HTMLInputElement => {
  const field = workspace.root.querySelector<HTMLInputElement>(
    'input[aria-label="Search Threads"]',
  );
  assert.ok(field, 'No Search Threads field.');
  return field;
};

/** Hovers `trigger` and answers the texts of the tooltips then drawn. */
const tooltipsOver = async (trigger: HTMLElement): Promise<string[]> => {
  for (const type of [
    'pointerover',
    'pointerenter',
    'pointermove',
    'mouseover',
    'mouseenter',
    'mousemove',
  ]) {
    const init = { bubbles: !type.endsWith('enter'), pointerType: 'mouse' };
    trigger.dispatchEvent(
      type.startsWith('pointer')
        ? new PointerEvent(type, init)
        : new MouseEvent(type, init),
    );
  }
  await settle();
  const texts = [
    ...document.querySelectorAll('[data-slot="tooltip-content"]'),
  ].map((content) => normalized(content.textContent));
  for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
    const init = { bubbles: type.endsWith('out'), pointerType: 'mouse' };
    trigger.dispatchEvent(
      type.startsWith('pointer')
        ? new PointerEvent(type, init)
        : new MouseEvent(type, init),
    );
  }
  await settle();
  return texts;
};

/** The toasts sonner draws, as their text. */
const toasts = (): string[] =>
  [...document.querySelectorAll('[data-sonner-toast]')].map((element) =>
    normalized(element.textContent),
  );

const deleteDialog = (): HTMLElement => {
  const dialog = document.querySelector<HTMLElement>(
    '[data-slot="alert-dialog-content"]',
  );
  assert.ok(dialog, 'No delete dialog.');
  return dialog;
};

const dialogDescription = (): string =>
  normalized(
    deleteDialog().querySelector('[data-slot="alert-dialog-description"]')
      ?.textContent,
  );

describe('the sidebar tabs (AC14)', () => {
  test('Chat and Archived are two icon-only tabs with tooltips and no counter; Chat is open', async () => {
    const workspace = await render();

    for (const name of ['Chat', 'Archived']) {
      const trigger = sidebarTab(workspace, name);
      assert.equal(
        normalized(trigger.textContent),
        '',
        `The ${name} tab shows text (a label or a counter).`,
      );
      assert.equal(
        trigger.querySelectorAll('svg').length,
        1,
        `The ${name} tab is not one icon.`,
      );
      const tooltips = await tooltipsOver(trigger);
      assert.ok(
        tooltips.includes(name),
        `Hovering the ${name} tab shows the tooltips ${JSON.stringify(tooltips)}.`,
      );
    }
    assert.equal(
      sidebarTab(workspace, 'Chat').getAttribute('aria-selected'),
      'true',
    );
    assert.equal(
      sidebarTab(workspace, 'Archived').getAttribute('aria-selected'),
      'false',
    );
  });

  test('New Thread shows in Chat only', async () => {
    const workspace = await render();
    assert.equal(named(workspace.root, 'button', 'New Thread').length, 1);

    await openTab(workspace, 'Archived');

    assert.equal(
      named(workspace.root, 'button', 'New Thread').length,
      0,
      'Archived shows New Thread.',
    );
  });

  test('the search filters the open tab and is kept when the tab changes', async () => {
    const workspace = await render();

    await type(search(workspace), 'old');
    assert.deepEqual(treeNames(workspace), [], 'Chat shows an archived match.');
    assert.equal(
      named(workspace.root, 'li', 'No threads match').length,
      1,
      'Chat does not say "No threads match".',
    );

    await openTab(workspace, 'Archived');
    assert.equal(search(workspace).value, 'old', 'The query was cleared.');
    assert.deepEqual(archivedOutline(workspace), [
      'Older',
      'Old notes',
      'Old findings',
    ]);

    await type(search(workspace), 'compare');
    assert.deepEqual(treeNames(workspace), [], 'Archived shows a Chat match.');
    assert.equal(named(workspace.root, 'li', 'No threads match').length, 1);
  });

  test('a sidebar draft row opens the Chat tab', async () => {
    const workspace = await render();
    await openTab(workspace, 'Archived');

    const projectTab = document.querySelector(
      `nav[aria-label="Workspace tabs"] [data-tab-id="${project.id}"]`,
    );
    assert.ok(projectTab, 'No Project tab.');
    await openMenu(projectTab);
    await pick('New thread');

    assert.equal(
      sidebarTab(workspace, 'Chat').getAttribute('aria-selected'),
      'true',
    );
    assert.ok(
      document.querySelector('[aria-label="New thread name"]'),
      'No draft row in the Chat tab.',
    );
  });
});

describe('the Chat tab (AC15)', () => {
  test('hides archived Threads but an archived ancestor of a Thread in Chat', async () => {
    const workspace = await render();

    assert.deepEqual(treeNames(workspace), [
      'Plan the checkout',
      'Research payments',
      'Compare providers',
      'Pinned idea',
      'Run the build',
    ]);
  });

  test('draws the archived ancestor dimmed with the Archived mark and no hover action', async () => {
    const workspace = await render();

    const context = row(workspace, 'Research payments');
    assert.ok(dimmed(context), 'The archived ancestor is not dimmed.');
    assert.deepEqual(marks(context), ['Archived']);
    assert.deepEqual(
      rowActions(context),
      [],
      'The context row has hover actions.',
    );
    assert.equal(dimmed(row(workspace, 'Compare providers')), false);
  });

  test("the archived ancestor's menu offers Open, Copy thread ID and Restore thread only, and Restore shows no toast", async () => {
    const workspace = await render();

    await openMenu(treeitem(row(workspace, 'Research payments')));
    assert.deepEqual(menuLabels(), [
      'Open in new tab',
      'Copy thread ID',
      'Restore thread',
    ]);

    await pick('Restore thread');
    const restored = row(workspace, 'Research payments');
    assert.deepEqual(
      marks(restored),
      [],
      'The restored Thread keeps its mark.',
    );
    assert.equal(dimmed(restored), false);
    assert.deepEqual(toasts(), [], 'Restore shows a toast.');
  });

  test('an archived ancestor stays selectable', async () => {
    const workspace = await render();

    await click(treeitem(row(workspace, 'Research payments')));

    assert.equal(pathOf(workspace), threadPathOf(ids.research));
  });
});

describe('the Archived tab (AC16, AC19, AC20)', () => {
  test('groups the archived Threads into Today, Last 7 days and Older, in tree form', async () => {
    const workspace = await render();

    await openTab(workspace, 'Archived');

    assert.deepEqual(archivedOutline(workspace), [
      'Today',
      'Plan the checkout',
      'Validate inputs',
      'Research payments',
      'Last 7 days',
      'Draft the spec',
      'Older',
      'Old notes',
      'Old findings',
    ]);
  });

  test('a non-archived ancestor is an inert, dimmed context row', async () => {
    const workspace = await render();
    await openTab(workspace, 'Archived');

    const context = row(workspace, 'Plan the checkout');
    const item = treeitem(context);
    assert.equal(item.getAttribute('aria-disabled'), 'true');
    assert.equal(item.tabIndex, -1);
    assert.ok(dimmed(context), 'The context row is not dimmed.');
    assert.deepEqual(rowActions(context), [], 'The context row has actions.');

    await click(item);
    assert.equal(pathOf(workspace), threadPathOf(ids.pinned), 'It selected.');

    await openMenu(item);
    assert.deepEqual(menuLabels(), [], 'The context row opens a menu.');
  });

  test('says "No archived threads" when nothing is archived', async () => {
    const workspace = await render({
      threads: fixtureThreads().filter(
        (candidate) => candidate.archivedAt === undefined,
      ),
    });

    await openTab(workspace, 'Archived');

    assert.deepEqual(treeNames(workspace), []);
    assert.equal(named(workspace.root, 'li', 'No archived threads').length, 1);
  });

  test('an archived agent thread offers Restore and Delete, on hover and in its menu', async () => {
    const workspace = await render();
    await openTab(workspace, 'Archived');

    const agent = row(workspace, 'Validate inputs');
    assert.deepEqual(rowActions(agent), ['Delete thread', 'Restore thread']);

    await openMenu(treeitem(agent));
    const labels = menuLabels();
    assert.ok(labels.includes('Restore thread'), labels.join(' | '));
    assert.ok(labels.includes('Delete thread'), labels.join(' | '));
    assert.ok(!labels.includes('Archive thread'), labels.join(' | '));
  });

  test('Restore returns the Thread to its place in Chat, without a toast', async () => {
    const workspace = await render();
    await openTab(workspace, 'Archived');

    await click(action(row(workspace, 'Validate inputs'), 'Restore thread'));

    assert.ok(
      !treeNames(workspace).includes('Validate inputs'),
      'The restored Thread is still in Archived.',
    );
    assert.deepEqual(toasts(), [], 'Restore shows a toast.');
    await openTab(workspace, 'Chat');
    assert.deepEqual(treeNames(workspace).slice(0, 2), [
      'Plan the checkout',
      'Validate inputs',
    ]);
  });

  test('Delete removes an archived agent thread after the dialog', async () => {
    const workspace = await render();
    await openTab(workspace, 'Archived');

    await click(action(row(workspace, 'Validate inputs'), 'Delete thread'));
    await click(only(deleteDialog(), 'button', 'Delete'));

    assert.ok(
      !treeNames(workspace).includes('Validate inputs'),
      'The deleted Thread is still drawn.',
    );
    assert.equal(
      await threadsOf(workspace).thread(ids.validate),
      undefined,
      'The host still holds the Thread.',
    );
  });

  // AC20 through the existing navigation (§10.7, D22): an archived child opens
  // as any child does — its main thread keeps the route and the child opens in
  // a selected viewer tab — and an archived main thread resolves its own route.
  test('an archived child opens in the viewer as any child does (AC20)', async () => {
    const workspace = await render({ path: threadPathOf(ids.plan) });
    await openTab(workspace, 'Archived');

    await click(treeitem(row(workspace, 'Validate inputs')));

    assert.equal(pathOf(workspace), threadPathOf(ids.plan));
    assert.equal(viewerTab(`thread:${ids.validate}`).dataset.active, 'true');
    assert.equal(
      sidebarTab(workspace, 'Archived').getAttribute('aria-selected'),
      'true',
      'Opening an archived Thread switched the sidebar tab.',
    );
  });

  test('an archived main thread is selectable and its route resolves (AC20)', async () => {
    const workspace = await render();
    await openTab(workspace, 'Archived');

    await click(treeitem(row(workspace, 'Research payments')));

    assert.equal(pathOf(workspace), threadPathOf(ids.research));
    assert.equal(
      treeitem(row(workspace, 'Research payments')).getAttribute(
        'aria-selected',
      ),
      'true',
    );
    assert.equal(
      sidebarTab(workspace, 'Archived').getAttribute('aria-selected'),
      'true',
      'Selecting an archived Thread switched the sidebar tab.',
    );
  });
});

describe('the delete dialog from Archived (AC23)', () => {
  const sentence = (count: number): string =>
    count === 1
      ? '1 child thread is still in Chat and will be deleted too.'
      : `${count} child threads are still in Chat and will be deleted too.`;

  test('names one child still in Chat', async () => {
    const workspace = await render();
    await openTab(workspace, 'Archived');

    await click(action(row(workspace, 'Research payments'), 'Delete thread'));

    assert.ok(
      dialogDescription().includes(sentence(1)),
      `The dialog reads: ${dialogDescription()}`,
    );
  });

  test('names two children still in Chat', async () => {
    const workspace = await render({
      threads: [
        ...fixtureThreads(),
        thread(ids.benchmark, 'Benchmark providers', {
          parentThreadId: ids.research,
          origin: 'user',
        }),
      ],
    });
    await openTab(workspace, 'Archived');

    await click(action(row(workspace, 'Research payments'), 'Delete thread'));

    assert.ok(
      dialogDescription().includes(sentence(2)),
      `The dialog reads: ${dialogDescription()}`,
    );
  });

  test('says nothing more when every descendant is archived', async () => {
    const workspace = await render();
    await openTab(workspace, 'Archived');

    await click(action(row(workspace, 'Old notes'), 'Delete thread'));

    assert.ok(
      !dialogDescription().includes('still in Chat'),
      `The dialog reads: ${dialogDescription()}`,
    );
    assert.ok(dialogDescription().length > 0, 'The dialog has no description.');
  });
});

describe('archive with Undo (AC17)', () => {
  test('an idle Chat row offers Archive next to its plus; a running one does not', async () => {
    const workspace = await render();

    assert.deepEqual(rowActions(row(workspace, 'Plan the checkout')), [
      'Archive thread',
      'New sub-thread in Plan the checkout',
    ]);
    assert.ok(
      !rowActions(row(workspace, 'Run the build')).includes('Archive thread'),
      'A running Thread offers Archive.',
    );
  });

  test('Archive moves the row to Archived and shows the toast; Undo restores its batch', async () => {
    const workspace = await render();
    const host = threadsOf(workspace);
    const archive = host.archiveThread.bind(host);
    const restore = host.restoreThread.bind(host);
    const batches: string[] = [];
    const undone: (string | undefined)[] = [];
    host.archiveThread = async (input, call) => {
      const answer = await archive(input, call);
      if (answer.status === 'archived') batches.push(answer.batch);
      return answer;
    };
    host.restoreThread = async (input, call) => {
      undone.push(input.batch);
      return restore(input, call);
    };

    await click(action(row(workspace, 'Plan the checkout'), 'Archive thread'));

    assert.ok(
      !treeNames(workspace).includes('Plan the checkout'),
      'The archived Thread is still in Chat.',
    );
    assert.deepEqual(toasts(), [
      'Thread archived"Plan the checkout" moved to ArchivedUndo',
    ]);

    const undo = [
      ...document.querySelectorAll<HTMLElement>('[data-sonner-toast] button'),
    ].find((button) => normalized(button.textContent) === 'Undo');
    assert.ok(undo, 'The toast has no Undo.');
    await click(undo);

    assert.equal(batches.length, 1);
    assert.deepEqual(undone, batches, 'Undo did not restore the batch.');
    assert.ok(
      treeNames(workspace).includes('Plan the checkout'),
      'Undo did not bring the Thread back to Chat.',
    );
  });

  test('the menu of a Chat row offers Archive thread', async () => {
    const workspace = await render();

    await openMenu(treeitem(row(workspace, 'Plan the checkout')));
    await pick('Archive thread');

    assert.ok(
      !treeNames(workspace).includes('Plan the checkout'),
      'The archived Thread is still in Chat.',
    );
  });
});

describe('pins (AC18)', () => {
  test('a pinned row shows the pin mark and Unpin on hover', async () => {
    const workspace = await render();

    const pinned = row(workspace, 'Pinned idea');
    assert.deepEqual(marks(pinned), ['Pinned']);
    assert.ok(rowActions(pinned).includes('Unpin thread'));

    await click(action(pinned, 'Unpin thread'));

    assert.deepEqual(marks(row(workspace, 'Pinned idea')), []);
    assert.ok(
      !rowActions(row(workspace, 'Pinned idea')).includes('Unpin thread'),
      'The unpinned row still offers Unpin.',
    );
  });

  test('the menu pins and unpins a Chat row', async () => {
    const workspace = await render();

    await openMenu(treeitem(row(workspace, 'Plan the checkout')));
    await pick('Pin thread');
    assert.deepEqual(marks(row(workspace, 'Plan the checkout')), ['Pinned']);

    await openMenu(treeitem(row(workspace, 'Plan the checkout')));
    await pick('Unpin thread');
    assert.deepEqual(marks(row(workspace, 'Plan the checkout')), []);
  });
});
