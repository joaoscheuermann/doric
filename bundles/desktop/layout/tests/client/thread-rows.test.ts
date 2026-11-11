// The Thread tree's rows after phase 2e and the sidebar alignment (spec
// docs/designs/sidebar-alignment.md §5, §6; U2, U11, SQ2):
// - one 16 px lead slot per row holding one icon: the kind icon, or the
//   Untitled icon (`message-circle-dashed`) for a Thread with an empty name;
//   no hover or focus swap and no chevron anywhere in the tree (U11); no 50 ms
//   rotate;
// - a row with children carries `aria-expanded` on its treeitem, `true` while
//   open and `false` while closed; a row without children has none (SQ2);
// - no repository mark on any row, though Threads carry `cwdRepo` (§4);
// - a row is active while its Thread runs, while a registration's `busy`
//   answers true for it, or while a descendant is active (§2): its name
//   shimmers and it has one `role="status"` named "Agent running" — the
//   elapsed badge at `right-1` when it has a badge start (§1), else a visually
//   hidden status with no text (D2);
// - the button's right padding follows `threadRowPadding` (§4 table).
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

/** A main Thread, idle, in a GitHub repository (no mark drawn); it has a plus (it branches). */
const plan = thread('3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a', 'Plan', {
  cwdRepo: 'github',
});
/** A sub-thread under Plan whose agent is running, in a local repository; no plus. */
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
/** A main Thread with nothing under it and no repository; it has a plus. */
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

/** The treeitem of the tree row `element`; fails unless there is one. */
const treeitem = (element: HTMLElement): HTMLElement => {
  const item = element.querySelector<HTMLElement>('[role="treeitem"]');
  assert.ok(item !== null, 'The row has no treeitem.');
  return item;
};

/** The classes that show or hide an element only on hover or focus. */
const hoverClass =
  /^(hidden|group-(hover|focus-within)\/tree-row:(hidden|block|flex|inline))$/u;

/** The hover- or focus-visibility classes in `slot` and below it. */
const hoverClassesIn = (slot: HTMLElement): string[] =>
  [slot, ...slot.querySelectorAll('*')].flatMap((element) =>
    [...element.classList].filter((name) => hoverClass.test(name)),
  );

/** Asserts every row's lead slot holds one icon that never swaps. */
const assertSteadyLeads = (workspace: RenderedWorkspace): void => {
  for (const element of rows(workspace)) {
    const name = normalized(treeitem(element).textContent);
    const slot = lead(element, name);
    assert.equal(
      slot.querySelectorAll('svg').length,
      1,
      `The lead slot of "${name}" does not hold exactly one icon.`,
    );
    assert.deepEqual(
      hoverClassesIn(slot),
      [],
      `The lead slot of "${name}" shows or hides on hover or focus.`,
    );
  }
  // Only the tree's rows: the stack panes' header toggles keep their chevron
  // (§6: the pane collapse chevron is a header control).
  assert.equal(
    rows(workspace).flatMap((element) => [
      ...element.querySelectorAll('svg.lucide-chevron-right'),
    ]).length,
    0,
    'The tree draws a chevron.',
  );
};

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

// T-1.6 (U11): every lead slot holds one icon, never swapped, with no chevron
test('T-1.6: every lead slot holds one icon that never swaps, and the tree draws no chevron', async () => {
  rendered = await renderTree();
  assertSteadyLeads(rendered);
});

// T-1.6 (U11): opening and closing work as before, with no swap while closed
test('T-1.6: activating a selected expandable row again collapses it, and its lead stays one icon', async () => {
  rendered = await renderTree();

  // Plan is selected and expandable, so pressing it closes its branch.
  treeitem(row(rendered, plan.name)).click();
  await settle();
  assert.equal(rendered.errors().length, 0, 'Closing Plan failed.');
  assert.equal(rows(rendered).length, 2, 'Closing Plan did not hide Form.');
  assertSteadyLeads(rendered);
});

// T-1.4 (§5): an Untitled Thread wears the Untitled icon in its lead slot
test("T-1.4: an Untitled row's lead slot holds the Untitled icon, a named row's does not", async () => {
  const untitled = thread('8b0d2f4a-6c8e-4a0b-9d2f-4a6c8e0b2d4f', '');
  rendered = await renderWorkspace({
    projects: [project],
    threads: [plan, untitled],
    path: `/projects/${project.id}/threads/${plan.id}`,
  });

  const [untitledRow, ...others] = rows(rendered).filter(
    (element) => normalized(treeitem(element).textContent) !== plan.name,
  );
  assert.ok(
    untitledRow !== undefined && others.length === 0,
    'The tree does not show one Untitled row.',
  );
  assert.equal(
    lead(untitledRow, 'Untitled').querySelectorAll(
      'svg.lucide-message-circle-dashed',
    ).length,
    1,
    "The Untitled row's lead slot does not hold the Untitled icon.",
  );
  assert.equal(
    lead(row(rendered, plan.name), plan.name).querySelectorAll(
      'svg.lucide-message-circle-dashed',
    ).length,
    0,
    "The named row's lead slot holds the Untitled icon.",
  );
});

// T-1.9 (SQ2): a row with child Threads says whether it is open
test('T-1.9: a row with a child Thread is aria-expanded true, then false once collapsed', async () => {
  rendered = await renderTree();

  const item = treeitem(row(rendered, plan.name));
  assert.equal(item.getAttribute('aria-expanded'), 'true');
  item.click();
  await settle();
  assert.equal(rows(rendered).length, 2, 'Closing Plan did not hide Form.');
  assert.equal(
    treeitem(row(rendered, plan.name)).getAttribute('aria-expanded'),
    'false',
  );
});

// T-1.9 (SQ2): rows a registration counts under a Thread are children too
test('T-1.9: a row with only registered rows under it carries aria-expanded', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [plan, audit],
    path: `/projects/${project.id}/threads/${plan.id}`,
    terminalRows: { [audit.id]: 1 },
  });

  assert.ok(
    treeitem(row(rendered, audit.name)).hasAttribute('aria-expanded'),
    'The row with terminal rows under it has no aria-expanded.',
  );
});

// T-1.9 (SQ2): a leaf row has no aria-expanded
test('T-1.9: a row without children has no aria-expanded', async () => {
  rendered = await renderTree();

  for (const name of [validate.name, audit.name]) {
    assert.equal(
      treeitem(row(rendered, name)).hasAttribute('aria-expanded'),
      false,
      `The leaf row "${name}" carries aria-expanded.`,
    );
  }
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

/** The rows' "Agent running" statuses in `element`. */
const statuses = (element: HTMLElement): HTMLElement[] =>
  [...element.querySelectorAll<HTMLElement>('[role="status"]')].filter(
    (status) => status.getAttribute('aria-label') === 'Agent running',
  );

/** The one "Agent running" status of a row; fails unless there is one. */
const status = (element: HTMLElement, name: string): HTMLElement => {
  const found = statuses(element);
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `The row "${name}" has ${found.length} "Agent running" statuses, not one.`,
  );
  return first;
};

/** Whether the row's name shimmers. */
const shimmers = (element: HTMLElement, name: string): boolean =>
  [...element.querySelectorAll<HTMLElement>('.shimmer')].some(
    (shimmer) => normalized(shimmer.textContent) === name,
  );

/** Asserts the row is active: a shimmering name and one status. */
const assertActive = (
  workspace: RenderedWorkspace,
  name: string,
): HTMLElement => {
  const element = row(workspace, name);
  assert.ok(shimmers(element, name), `The active row "${name}" does not shimmer.`);
  return status(element, name);
};

/** Asserts the row is inactive: no shimmer, no status. */
const assertInactive = (workspace: RenderedWorkspace, name: string): void => {
  const element = row(workspace, name);
  assert.equal(shimmers(element, name), false, `The idle row "${name}" shimmers.`);
  assert.equal(statuses(element).length, 0, `The idle row "${name}" says an agent is running.`);
};

/** The classes `names` that `element` lacks. */
const missing = (element: HTMLElement, names: readonly string[]): string[] =>
  names.filter((name) => !element.classList.contains(name));

/** Plan idle: its latest execution took four minutes and ended a minute ago. */
const timedPlan = (): Thread => ({
  ...plan,
  result: {
    status: 'completed',
    text: '',
    promptId: '1f3b5d7f-9a1c-4e3a-8c5e-7a9c1e3b5d7f',
    at: new Date(Date.now() - 60_000).toISOString(),
  },
  lastExecutionMs: 4 * 60_000,
});

/** The workspace at Plan with these Threads, every branch open. */
const renderThreads = async (
  threads: readonly Thread[],
  options: { readonly terminalBusy?: readonly string[] } = {},
): Promise<RenderedWorkspace> =>
  renderWorkspace({
    projects: [project],
    threads,
    path: `/projects/${project.id}/threads/${plan.id}`,
    ...options,
  });

// T-2.7 (§1, §2, §4): an ancestor of a running Thread is active and counts
// from its own latest execution
test('T-2.7: an idle Plan over a running Form is active with its own elapsed time; Audit is not', async () => {
  rendered = await renderThreads([timedPlan(), form, validate, audit]);

  const badge = assertActive(rendered, plan.name);
  assert.ok(
    normalized(badge.textContent).startsWith('05:'),
    `Plan's badge reads "${normalized(badge.textContent)}", not five minutes.`,
  );
  assertActive(rendered, form.name);
  assertInactive(rendered, audit.name);
});

// T-2.7 (§2, §3): a busy terminal makes its Thread and every ancestor active,
// collapsed or not
test('T-2.7: a busy agent terminal under Validate makes Validate, Form and Plan active, and Plan stays active collapsed', async () => {
  const {
    activePromptId: _prompt,
    executionStartedAt: _started,
    ...rest
  } = form;
  const idleForm: Thread = { ...rest, state: 'ready' };
  rendered = await renderThreads([plan, idleForm, validate, audit], {
    terminalBusy: [validate.id],
  });

  for (const name of [validate.name, form.name, plan.name]) {
    assertActive(rendered, name);
  }
  assertInactive(rendered, audit.name);

  treeitem(row(rendered, plan.name)).click();
  await settle();
  assert.equal(rendered.errors().length, 0, 'Collapsing Plan failed.');
  assert.equal(rows(rendered).length, 2, 'Collapsing Plan did not hide Form.');
  assertActive(rendered, plan.name);
});

// T-2.7 (D2): an active row without a badge start keeps a hidden status
test('T-2.7: an active Plan without a whole latest execution shimmers with a hidden, empty status', async () => {
  rendered = await renderTree();

  const hidden = assertActive(rendered, plan.name);
  assert.ok(hidden.classList.contains('sr-only'), "Plan's status is visible.");
  assert.equal(normalized(hidden.textContent), '', "Plan's status has text.");
});

// T-2.8 (§4): no repository mark, and the row's padding follows its slot
test('T-2.8: no row draws a repository mark though its Thread has cwdRepo', async () => {
  rendered = await renderThreads([timedPlan(), form, validate, audit]);

  for (const element of rows(rendered)) {
    assert.equal(
      element.querySelectorAll(
        'span[title="Git repository"], span[title="GitHub repository"]',
      ).length,
      0,
      `The row "${normalized(treeitem(element).textContent)}" draws a repository mark.`,
    );
  }
});

test('T-2.8: the elapsed badge sits at the right edge and gives way to the plus on hover or focus', async () => {
  rendered = await renderThreads([timedPlan(), form, validate, audit]);

  // Form: timed, no plus.
  const formBadge = assertActive(rendered, form.name);
  assert.ok(formBadge.classList.contains('right-1'), "Form's badge is not at the right edge.");
  assert.deepEqual(missing(treeitem(row(rendered, form.name)), ['pr-14']), []);

  // Plan: timed, with the plus.
  const planRow = row(rendered, plan.name);
  const planBadge = assertActive(rendered, plan.name);
  assert.deepEqual(
    missing(planBadge, [
      'right-1',
      'group-hover/tree-row:opacity-0',
      'group-focus-within/tree-row:opacity-0',
    ]),
    [],
    "Plan's badge is not at the right edge or does not fade on hover or focus.",
  );
  const plus = planRow.querySelector<HTMLElement>(
    `[aria-label="New sub-thread in ${plan.name}"]`,
  );
  assert.ok(plus !== null, 'Plan has no plus.');
  assert.ok(
    plus.classList.contains('group-hover/tree-row:opacity-100'),
    "Plan's plus does not show on hover.",
  );
  assert.deepEqual(missing(treeitem(planRow), ['pr-14']), []);

  // Audit: idle, with the plus.
  assert.deepEqual(
    missing(treeitem(row(rendered, audit.name)), [
      'pr-1.5',
      'group-hover/tree-row:pr-8',
    ]),
    [],
    "Audit's padding does not widen for its plus on hover only.",
  );
});

test('T-2.8: an active row without a badge start keeps the rest padding, and no row pads to pr-16 or pr-8 at rest', async () => {
  rendered = await renderTree();

  assert.deepEqual(missing(treeitem(row(rendered, plan.name)), ['pr-1.5']), []);
  for (const element of rows(rendered)) {
    const item = treeitem(element);
    assert.deepEqual(
      ['pr-16', 'pr-8'].filter((name) => item.classList.contains(name)),
      [],
      `The row "${normalized(item.textContent)}" pads to pr-16 or pr-8 at rest.`,
    );
  }
});
