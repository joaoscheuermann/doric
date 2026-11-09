// The Thread tree's rows after phase 2e (spec §2.2, §2.3; contracts 2e §2.2,
// §2.3, §5):
// - one 16 px lead slot per row: the kind icon on a row that opens nothing;
//   on an expandable row, open or closed, the kind icon at rest, which the
//   chevron replaces on hover or focus, turned down while open (the approved
//   decision that follows the prototype `99:8035` over S25 for thread rows);
//   no 50 ms rotate;
// - the trailing marks show only while the row is hovered or running: an idle
//   row's repository mark is transparent at rest, a running row says "Agent
//   running".
// happy-dom computes no layout or hover, so these read the classes that draw
// them, and only those the contract names.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { Project, Thread } from '../../src/client/domain/workspace.js';
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

/** A main Thread, idle, in a GitHub repository; it has a plus (it branches). */
const plan = thread('3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a', 'Plan', {
  cwdRepo: 'github',
});
/** A sub-thread under Plan whose agent is running, in a local repository. */
const form = thread('7e9f1a3b-5c7d-4e9f-a1b3-c5d7e9f1a3b5', 'Form', {
  parentThreadId: plan.id,
  cwdRepo: 'git',
  state: 'running',
  activePromptId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  executionStartedAt: '2026-11-09T09:58:00.000Z',
});
/** An idle agent Thread under Form, in a local repository; no plus. */
const validate = thread('2c4e6a8b-0d1f-4a3c-8e5b-7d9f1b3c5e7a', 'Validate', {
  parentThreadId: form.id,
  origin: 'agent',
  cwdRepo: 'git',
});
/** A main Thread with nothing under it and no repository. */
const audit = thread('5a7c9e1b-3d5f-4b7d-9f1a-3c5e7a9b1d3f', 'Audit');

let rendered: RenderedWorkspace | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

/** The workspace at Plan, with every branch open (Threads start open). */
const renderTree = async (): Promise<RenderedWorkspace> =>
  renderWorkspace({
    projects: [project],
    threads: [plan, form, validate, audit],
    path: `/projects/${project.id}/threads/${plan.id}`,
  });

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

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
    `Expected one tree row named "${name}", found ${found.length}.`,
  );
  return first;
};

/** The row's lead slots. */
const leads = (element: HTMLElement): HTMLElement[] => [
  ...element.querySelectorAll<HTMLElement>('span[data-slot="thread-lead"]'),
];

/** The one lead slot of `element`; fails unless there is exactly one. */
const lead = (element: HTMLElement, name: string): HTMLElement => {
  const found = leads(element);
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `The row "${name}" has ${found.length} lead slots, not one.`,
  );
  return first;
};

const isChevron = (icon: Element): boolean =>
  icon.classList.contains('lucide-chevron-right');

/** Whether `element`, or an ancestor of it inside `slot`, carries `name`. */
const carries = (element: Element, slot: Element, name: string): boolean => {
  for (
    let current: Element | null = element;
    current !== null && current !== slot;
    current = current.parentElement
  ) {
    if (current.classList.contains(name)) return true;
  }
  return false;
};

/** The icons drawn in `slot`, split into chevrons and the rest (kind icons). */
const iconsOf = (slot: HTMLElement) => {
  const icons = [...slot.querySelectorAll('svg')];
  return {
    chevrons: icons.filter(isChevron),
    kinds: icons.filter((icon) => !isChevron(icon)),
  };
};

const missing = (
  element: Element,
  slot: Element,
  classes: readonly string[],
): string[] => classes.filter((name) => !carries(element, slot, name));

// §2.2: one lead slot per row
test('every tree row has exactly one thread-lead slot', async () => {
  rendered = await renderTree();

  const all = rows(rendered);
  assert.equal(all.length, 4, 'The tree does not show all four Threads.');
  assert.deepEqual(
    all.map((element) => leads(element).length),
    [1, 1, 1, 1],
    'A row does not have exactly one lead slot.',
  );
});

// §2.2: a row that opens nothing shows its kind icon alone
test("a non-expandable row's lead slot holds only the kind icon", async () => {
  rendered = await renderTree();

  for (const name of [validate.name, audit.name]) {
    const { chevrons, kinds } = iconsOf(lead(row(rendered, name), name));
    assert.equal(chevrons.length, 0, `The row "${name}" draws a chevron.`);
    assert.equal(kinds.length, 1, `The row "${name}" has no single kind icon.`);
  }
});

// Prototype `99:8035` (approved over S25): an open row shows its kind icon at
// rest; the chevron, turned down, replaces it on hover or focus
test('an open row shows its kind icon at rest and the turned-down chevron only on hover or focus', async () => {
  rendered = await renderTree();

  for (const name of [plan.name, form.name]) {
    const slot = lead(row(rendered, name), name);
    const { chevrons, kinds } = iconsOf(slot);
    assert.equal(kinds.length, 1, `The open row "${name}" has no kind icon.`);
    assert.equal(chevrons.length, 1, `The open row "${name}" has no chevron.`);
    const [kind] = kinds;
    const [chevron] = chevrons;
    assert.ok(kind !== undefined && chevron !== undefined);
    assert.deepEqual(
      missing(kind, slot, [
        'group-hover/tree-row:hidden',
        'group-focus-within/tree-row:hidden',
      ]),
      [],
      `The kind icon of the open row "${name}" does not hide on hover or focus.`,
    );
    assert.ok(
      !carries(kind, slot, 'hidden'),
      `The kind icon of the open row "${name}" is hidden at rest.`,
    );
    assert.deepEqual(
      missing(chevron, slot, [
        'hidden',
        'group-hover/tree-row:block',
        'group-focus-within/tree-row:block',
        'rotate-90',
      ]),
      [],
      `The chevron of the open row "${name}" is not hidden at rest, shown on hover or focus and turned down.`,
    );
  }
});

// §2.2: a closed expandable row swaps its kind icon for the chevron
test('a closed expandable row shows its kind icon and the chevron only on hover', async () => {
  rendered = await renderTree();

  // Plan is selected and expandable, so pressing it closes its branch.
  const item = row(rendered, plan.name).querySelector<HTMLElement>(
    '[role="treeitem"]',
  );
  assert.ok(item !== null, 'Plan has no treeitem.');
  item.click();
  await settle();
  assert.equal(rendered.errors().length, 0, 'Closing Plan failed.');
  assert.equal(rows(rendered).length, 2, 'Closing Plan did not hide Form.');

  const slot = lead(row(rendered, plan.name), plan.name);
  const { chevrons, kinds } = iconsOf(slot);
  assert.equal(kinds.length, 1, 'The closed row has no single kind icon.');
  assert.equal(chevrons.length, 1, 'The closed row has no single chevron.');
  const [kind] = kinds;
  const [chevron] = chevrons;
  assert.ok(kind !== undefined && chevron !== undefined);
  assert.deepEqual(
    missing(kind, slot, ['group-hover/tree-row:hidden']),
    [],
    'The kind icon does not hide while the row is hovered.',
  );
  assert.deepEqual(
    missing(chevron, slot, ['hidden', 'group-hover/tree-row:block']),
    [],
    'The chevron is not hidden at rest and shown on hover.',
  );
});

// §2.2: the 50 ms rotate goes
test('no icon in a tree row carries a 50 ms transition', async () => {
  rendered = await renderTree();

  const timed = rows(rendered).flatMap((element) =>
    [...element.querySelectorAll('svg')].filter((icon) =>
      icon.classList.contains('duration-[50ms]'),
    ),
  );
  assert.equal(timed.length, 0, 'A row icon still carries duration-[50ms].');
});

/** The repository marks in `element` with the title `title`. */
const marks = (element: HTMLElement, title: string): HTMLElement[] => [
  ...element.querySelectorAll<HTMLElement>(`span[title="${title}"]`),
];

// §2.3 table: idle rows show no mark at rest
test("an idle row's repository mark is transparent at rest", async () => {
  rendered = await renderTree();

  // Idle, no plus, in a repository: the mark shows on hover or focus.
  const [shownOnHover] = marks(row(rendered, validate.name), 'Git repository');
  assert.ok(shownOnHover !== undefined, 'Validate draws no repository mark.');
  assert.deepEqual(
    [
      'opacity-0',
      'group-hover/tree-row:opacity-100',
      'group-focus-within/tree-row:opacity-100',
    ].filter((name) => !shownOnHover.classList.contains(name)),
    [],
    "The idle row's mark is not hidden at rest and shown on hover or focus.",
  );

  // Idle, with a plus: the plus takes the mark's place on hover, so the mark
  // never shows (coordinator decision 1).
  const [underPlus] = marks(row(rendered, plan.name), 'GitHub repository');
  assert.ok(underPlus !== undefined, 'Plan draws no repository mark.');
  assert.ok(
    underPlus.classList.contains('opacity-0'),
    "The idle row's mark shows at rest beside its plus.",
  );
});

// §2.3 table: a running row shows its elapsed time and mark
test('a running row says Agent running and shows its repository mark', async () => {
  rendered = await renderTree();

  const running = row(rendered, form.name);
  const statuses = [
    ...running.querySelectorAll<HTMLElement>('[role="status"]'),
  ].filter((element) => element.getAttribute('aria-label') === 'Agent running');
  assert.equal(statuses.length, 1, 'The running row does not say so.');
  const [mark] = marks(running, 'Git repository');
  assert.ok(mark !== undefined, 'The running row draws no repository mark.');
  assert.ok(
    !mark.classList.contains('opacity-0'),
    "The running row's repository mark is hidden.",
  );
  assert.equal(
    row(rendered, validate.name).querySelectorAll('[role="status"]').length,
    0,
    'An idle row says an agent is running.',
  );
});
