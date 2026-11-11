// ⌘F Thread search (§4.3, S13, T-4.3.1–T-4.3.4, T-4.3.6–T-4.3.8; plan-4 G3,
// G4, G5, G7, G8), as the reader meets it in the workspace: the "Search
// Threads" field under the Project sidebar's header filters the tree, ⌘F or
// Ctrl+F focuses it except inside Monaco or a terminal, Escape clears it and
// returns focus to the tree, and the Dashboard's header has a Search button.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { NavigationV1 } from 'bundle/contracts';

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

const docs: Project = {
  id: 'b7d4e2f1-8c3a-4d5e-9f6a-2b1c3d4e5f6a',
  name: 'Docs site',
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
};

const thread = (id: string, name: string, parentThreadId?: string): Thread => ({
  id,
  projectId: project.id,
  ...(parentThreadId === undefined ? {} : { parentThreadId }),
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:30:00.000Z',
});

// The tree of `99:8035`.
const plan = thread(
  '3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a',
  'Plan the checkout flow',
);
const build = thread(
  '7e9f1a3b-5c7d-4e9f-a1b3-c5d7e9f1a3b5',
  'Build the payment form',
  plan.id,
);
const validate = thread(
  '2c4e6a8b-0d1f-4a3c-8e5b-7d9f1b3c5e7a',
  'Validate card numbers',
  build.id,
);
const review = thread(
  '8b0d2f4a-6c8e-4a0c-9e2b-4d6f8a0c2e4b',
  'Review error copy',
  plan.id,
);
const audit = thread(
  '5a7c9e1b-3d5f-4b7d-9f1a-3c5e7a9b1d3f',
  'Accessibility audit',
);
const nameless = thread('1f3b5d7a-9c1e-4f3b-8d5a-7c9e1b3d5f7a', '');
const threads = [plan, build, validate, review, audit, nameless];

const SEARCH = 'input[aria-label="Search Threads"]';

let rendered: RenderedWorkspace | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

/** The Project at `path`, with the tree above and the stack's Screens pane. */
const renderProject = async (
  fixture: LayoutFixture = {},
): Promise<RenderedWorkspace> =>
  renderWorkspace({
    projects: [project, docs],
    projectTabs: [project, docs],
    threads,
    path: `/projects/${project.id}`,
    ...fixture,
  });

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

const single = <T extends HTMLElement = HTMLElement>(
  root: ParentNode,
  selector: string,
): T => {
  const found = [...root.querySelectorAll<T>(selector)];
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `Expected one ${selector}, found ${found.length}.`,
  );
  return first;
};

const field = (workspace: RenderedWorkspace): HTMLInputElement =>
  single<HTMLInputElement>(workspace.root, SEARCH);

/** The names the tree draws, top to bottom. */
const treeNames = (workspace: RenderedWorkspace): string[] =>
  [...workspace.root.querySelectorAll('[role="treeitem"]')].map((item) =>
    normalized(item.textContent),
  );

const treeItem = (workspace: RenderedWorkspace, name: string): HTMLElement =>
  only(workspace.root, '[role="treeitem"]', name);

const conversation = (workspace: RenderedWorkspace): HTMLElement =>
  single(workspace.root, 'main[data-slot="sidebar-inset"]');

const click = async (element: HTMLElement): Promise<void> => {
  element.click();
  await settle();
};

/** Dispatches a cancelable keydown at `target`; answers whether it was prevented. */
const key = async (
  target: EventTarget,
  init: KeyboardEventInit,
): Promise<boolean> => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  await settle();
  return event.defaultPrevented;
};

/** Types `text` into `input` as the reader does: React sees the new value. */
const type = async (input: HTMLInputElement, text: string): Promise<void> => {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
};

/** A focusable element outside the sidebar, inside the conversation. */
const focusInConversation = (
  workspace: RenderedWorkspace,
  className?: string,
): HTMLElement => {
  const host = document.createElement('div');
  if (className !== undefined) host.className = className;
  const inner = document.createElement('textarea');
  host.append(inner);
  conversation(workspace).append(host);
  inner.focus();
  return inner;
};

const selectsAll = (input: HTMLInputElement): boolean =>
  input.selectionStart === 0 && input.selectionEnd === input.value.length;

// A failed assertion on a happy-dom node walks its whole window when it prints
// the node, so focus is asserted as a boolean.

// T-4.3.1
for (const [label, init] of [
  ['⌘F', { key: 'f', metaKey: true }],
  ['Ctrl+F', { key: 'f', ctrlKey: true }],
] as const) {
  test(`${label} from the conversation focuses Search Threads and selects its text`, async () => {
    rendered = await renderProject();
    await type(field(rendered), 'pay');
    const target = focusInConversation(rendered);
    assert.ok(document.activeElement !== field(rendered));

    const prevented = await key(target, init);

    assert.ok(
      document.activeElement === field(rendered),
      `${label} does not focus Search Threads.`,
    );
    assert.ok(selectsAll(field(rendered)), `${label} does not select "pay".`);
    assert.ok(prevented, `${label} is not prevented.`);
  });
}

// T-4.3.2
for (const editor of ['monaco-editor', 'xterm']) {
  test(`⌘F inside .${editor} keeps focus there and is not prevented`, async () => {
    rendered = await renderProject();
    const target = focusInConversation(rendered, editor);

    const prevented = await key(target, { key: 'f', metaKey: true });

    assert.ok(document.activeElement === target, 'Focus moved.');
    assert.equal(prevented, false, `⌘F inside .${editor} was prevented.`);
  });
}

// T-4.3.3
test('typing keeps the matches and their ancestors expanded and hides the rest; no match says so', async () => {
  rendered = await renderProject();
  assert.equal(treeNames(rendered).length, 6);

  await type(field(rendered), 'card');

  assert.deepEqual(treeNames(rendered), [plan.name, build.name, validate.name]);
  assert.equal(
    named(rendered.root, 'li, div, span', 'No threads match').length,
    0,
    'Focus is not where expected.',
  );

  await type(field(rendered), 'zzz');

  assert.deepEqual(treeNames(rendered), []);
  assert.ok(
    named(rendered.root, 'li', 'No threads match').length === 1,
    'The empty result does not say "No threads match".',
  );
});

// T-4.3.3: the name a row shows
test('"untitled" finds the Thread without a name', async () => {
  rendered = await renderProject();

  await type(field(rendered), 'untitled');

  assert.deepEqual(treeNames(rendered), ['Untitled']);
});

// T-4.3.4, G8
test('Escape clears the query and focuses the selected Thread row', async () => {
  rendered = await renderProject({
    path: `/projects/${project.id}/threads/${audit.id}`,
  });
  await type(field(rendered), 'audit');

  await key(field(rendered), { key: 'Escape' });

  assert.equal(field(rendered).value, '');
  assert.equal(treeNames(rendered).length, 6, 'The tree is still filtered.');
  assert.ok(
    document.activeElement === treeItem(rendered, audit.name),
    'Escape does not focus the selected row.',
  );
});

// T-4.3.4, G8
test('Escape with no selected Thread focuses the first row', async () => {
  rendered = await renderProject();
  await type(field(rendered), 'review');

  await key(field(rendered), { key: 'Escape' });

  assert.equal(field(rendered).value, '');
  assert.ok(
    document.activeElement === treeItem(rendered, plan.name),
    'Escape does not focus the first row.',
  );
});

// T-4.3.4
test('selecting another Project clears the query', async () => {
  rendered = await renderProject();
  await type(field(rendered), 'zzz');

  await click(only(rendered.root, 'button[aria-label]', docs.name));
  assert.equal(
    rendered.services.use(NavigationV1).current()?.path,
    `/projects/${docs.id}`,
  );
  await click(only(rendered.root, 'button[aria-label]', project.name));

  assert.equal(field(rendered).value, '');
  assert.equal(treeNames(rendered).length, 6);
});

// T-4.3.6 as amended by G3
test('the Project header has no Search button', async () => {
  rendered = await renderProject();

  const header = single(
    rendered.root,
    '[data-slot="workspace-sidebar-header"]',
  );
  assert.equal(named(header, 'button', 'Search').length, 0);
});

// T-4.3.6 as amended by G3
test("the Dashboard header's Search button focuses Search projects and selects its text", async () => {
  rendered = await renderWorkspace({ projects: [project], path: '/projects' });
  const projects = single<HTMLInputElement>(
    rendered.root,
    'input[aria-label="Search projects"]',
  );
  await type(projects, 'check');
  const elsewhere = document.createElement('textarea');
  rendered.root.append(elsewhere);
  elsewhere.focus();

  const header = single(
    rendered.root,
    '[data-slot="workspace-sidebar-header"]',
  );
  await click(only(header, 'button', 'Search'));

  assert.ok(document.activeElement === projects);
  assert.ok(selectsAll(projects), 'The Search button does not select "check".');
});

// T-4.3.7
test("a shown Thread's terminal rows show with it and a hidden Thread's hide with it", async () => {
  rendered = await renderProject({ terminalRows: { [audit.id]: 1 } });
  const terminalRows = (): number =>
    named(rendered?.root ?? document, 'button', 'npm run dev').length;
  assert.equal(terminalRows(), 1);

  await type(field(rendered), 'audit');
  assert.equal(terminalRows(), 1, "The shown Thread's terminal row is gone.");

  await type(field(rendered), 'pay');
  assert.equal(terminalRows(), 0, "The hidden Thread's terminal row shows.");
});

// T-4.3.7
test('the Screens pane renders its items whatever the query', async () => {
  rendered = await renderProject();
  const toggle = named(rendered.root, 'button', 'Expand Screens')[0];
  if (toggle !== undefined) await click(toggle);
  const screens = (): number =>
    rendered?.root.querySelectorAll('[data-story-placeholder="screen-sidebar"]')
      .length ?? 0;
  assert.equal(screens(), 1);

  await type(field(rendered), 'zzz');

  assert.equal(screens(), 1, 'The Screens pane is filtered.');
});

// T-4.3.8
test('a collapsed ancestor is drawn expanded during a query and collapsed after it; an expanded one stays expanded', async () => {
  rendered = await renderProject({
    path: `/projects/${project.id}/threads/${plan.id}`,
  });
  // Plan is selected, so pressing its row collapses it.
  await click(treeItem(rendered, plan.name));
  assert.deepEqual(treeNames(rendered), [plan.name, audit.name, 'Untitled']);

  await type(field(rendered), 'card');
  assert.deepEqual(treeNames(rendered), [plan.name, build.name, validate.name]);

  await key(field(rendered), { key: 'Escape' });
  assert.deepEqual(
    treeNames(rendered),
    [plan.name, audit.name, 'Untitled'],
    'Plan is not collapsed again after the query.',
  );

  await click(treeItem(rendered, plan.name));
  assert.deepEqual(
    treeNames(rendered),
    [plan.name, build.name, validate.name, review.name, audit.name, 'Untitled'],
    'Build the payment form did not stay expanded.',
  );
});

// G5, T-3.1
test('the Threads have no pane header, with or without a registered pane', async () => {
  const threadsToggles = ({ root }: RenderedWorkspace): number =>
    named(root, 'button', 'Collapse Threads').length +
    named(root, 'button', 'Expand Threads').length;

  rendered = await renderProject({ panes: [] });
  assert.equal(threadsToggles(rendered), 0, 'The Threads draw a pane header.');
  assert.equal(treeNames(rendered).length, 6, 'The Thread tree is empty.');
  rendered.cleanup();

  // Loaded after the window is installed, as React DOM must be.
  const { screenPane } = await import('../../stories/support/fake-host.js');
  rendered = await renderProject({ panes: [screenPane] });
  assert.equal(
    threadsToggles(rendered),
    0,
    'A second pane brings back the Threads pane header.',
  );
  only(rendered.root, 'button', 'Expand Screens');
  assert.equal(treeNames(rendered).length, 6, 'The Thread tree is empty.');
});

// G7
test('pressing New Thread during a query clears it and shows the draft row', async () => {
  rendered = await renderProject();
  await type(field(rendered), 'pay');

  await click(only(rendered.root, 'button', 'New Thread'));

  assert.equal(field(rendered).value, '');
  assert.equal(treeNames(rendered).length, 6, 'The tree is still filtered.');
  assert.equal(
    named(rendered.root, '[role="textbox"]', 'New thread name').length,
    1,
    'The draft row does not show.',
  );
});
