// The layout's failure surfaces after the error-messages change (spec §5.3,
// §7.2, §7.3, §8; T-27 … T-31, T-33, T-34), through the whole workspace view
// on the stories' fake host:
// - the one workspace error: a failed load keeps a retry target and offers
//   Retry, which loads that target again; a failed write or copy offers none;
//   a successful load clears only an error with the same target; a reader
//   action keeps an older load's failure from landing (T-27, T-28);
// - a failed rename shows only the workspace notice, a refused name only its
//   reason under the name, and neither a toast (T-29);
// - the dashboard's bodies draw the same notice, and its projects list load
//   failure retries `activity.refetch` (T-30, T-31);
// - the window's quarantine notice sits at the bottom of each frame's left
//   sidebar, and nowhere else (T-33);
// - `ElementHost` shows a compact notice when `ui.create` throws (T-34).
//
// The host is the boundary these tests control: a read is made to fail or to
// answer later by replacing members of the fake host's records mirror, and the
// clipboard by replacing `navigator.clipboard`.
//
// The fake host's records mirror (bundle isolation phase 3), the shape these
// tests need from `stories/support/fake-host.ts`:
// - `FakeHost.records: RuntimeRecords` is the object the fake host answers
//   `use('runtime.records/v1')` with, built by `createRecordsApi` from the
//   host options (`projects`, `threads`, `connection`, `pending`, `failing`;
//   the operation `thread` is `findThread`). Every `use` returns this same
//   object, so a test replaces its members (`projects`, `threads`, `reload`,
//   `activity`, a write) and the layout calls the replacement;
// - `FakeHost.notifyRecords(): void` calls every listener subscribed through
//   that object's `subscribe`, as the mirror does when a read changes. It
//   reaches the listeners subscribed before a test replaced a member.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  type CatalogBundle,
  type CatalogSnapshot,
  NavigationV1,
  ref,
  UiV1,
} from 'bundle/contracts';
import { ClientError } from 'desktop/reads';
import type {
  ProjectActivity,
  RecordsRead,
  RuntimeRecords,
} from 'runtime/contracts';

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

const thread = (id: string, name: string, projectId = project.id): Thread => ({
  id,
  projectId,
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:30:00.000Z',
});

const plan = thread(
  '3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a',
  'Plan the checkout',
);
const guide = thread(
  '9c1e3a5b-7d9f-4b1d-8f3a-5c7e9a1b3d5f',
  'Write the guide',
  docs.id,
);

const projectPath = (target: Project): string => `/projects/${target.id}`;

let rendered: RenderedWorkspace | undefined;
const restores: (() => void)[] = [];

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  for (const restore of restores.splice(0).reverse()) restore();
  document.body.replaceChildren();
});

const render = async (fixture: LayoutFixture): Promise<RenderedWorkspace> => {
  rendered = await renderWorkspace({
    projects: [project, docs],
    projectTabs: [project, docs],
    threads: [plan, guide],
    ...fixture,
  });
  return rendered;
};

// The records mirror, as the layout reads it ----------------------------------

/** The mirror the fake host answers `runtime.records/v1` with; its members are replaceable. */
const recordsOf = (workspace: RenderedWorkspace): RuntimeRecords => {
  const records = workspace.records;
  assert.equal(
    workspace.services.use(ref<RuntimeRecords>('runtime.records/v1')),
    records,
    'The fake host does not answer runtime.records/v1 with its records.',
  );
  return records;
};

type ReloadInput = Parameters<RuntimeRecords['reload']>[0];

/**
 * Replaces `reload` of the mirror: `load(input)` runs in its place and changes
 * what the replaced reads answer, and the mirror tells its subscribers once
 * the call has returned, as it does when a load settles.
 */
const onReload = (
  workspace: RenderedWorkspace,
  load: (input: ReloadInput) => void = () => undefined,
): void => {
  recordsOf(workspace).reload = (input) => {
    load(input);
    queueMicrotask(() => workspace.notifyRecords());
  };
};

const ready = <Value>(value: Value): RecordsRead<Value> => ({
  status: 'ready',
  value,
});

/** A host answer the test settles when it chooses. */
interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<Value>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/**
 * A failure the host names no known code for: `internal`, which the layout
 * titles with its own fallback ("Projects not loaded", "Change not saved").
 * A rejection keeps the host's code, so `unavailable` would be titled by the
 * shared catalog instead.
 */
const hostFailure = (): ClientError =>
  new ClientError('internal', 'The host failed.');

/** A read whose load failed with `hostFailure`. */
const failedRead = <Value>(): RecordsRead<Value> => ({
  status: 'failed',
  error: hostFailure(),
});

/** The mirror's reads a test makes fail with `hostFailure`. */
type FailedRead = 'projects' | 'threads' | 'activity';

/**
 * Renders `fixture` with each read of `failed` failing with `hostFailure`.
 * The fake host's `failing` option fails with `unavailable`, so instead:
 * - `projects` and `threads` start pending, and their members are then
 *   replaced with ones that answer `failed`; the mirror's subscribers are
 *   told, as when a load settles;
 * - `activity` is replaced before the dashboard first asks for it: a render
 *   at `/projects` starts on a Project and then navigates to the dashboard.
 */
const renderFailing = async (
  fixture: LayoutFixture & { readonly path: string },
  failed: readonly FailedRead[],
): Promise<RenderedWorkspace> => {
  const laterDashboard =
    failed.includes('activity') && fixture.path === '/projects';
  const workspace = await render({
    ...fixture,
    path: laterDashboard ? projectPath(project) : fixture.path,
    pending: failed.filter((read) => read !== 'activity'),
  });
  const records = recordsOf(workspace);
  if (failed.includes('projects')) records.projects = () => failedRead();
  if (failed.includes('threads')) records.threads = () => failedRead();
  if (failed.includes('activity')) {
    records.activity = () => Promise.reject(hostFailure());
  }
  workspace.notifyRecords();
  await settle();
  if (laterDashboard) await navigate(workspace, '/projects');
  return workspace;
};

// The DOM a reader sees ------------------------------------------------------

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** The accessible name of a control: its `aria-label`, else its text. */
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

const key = async (element: HTMLElement, init: KeyboardEventInit) => {
  element.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  );
  await settle();
};

const navigate = async (
  workspace: RenderedWorkspace,
  path: string,
): Promise<void> => {
  workspace.services.use(NavigationV1).navigate(path);
  await settle();
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

/** The workspace notices: every notice but the quarantine notice. */
const workspaceNotices = (root: ParentNode): HTMLElement[] =>
  notices(root).filter((notice) => notice.dataset.tone !== 'warning');

/** The one workspace notice under `root`; fails naming what is there. */
const workspaceNotice = (root: ParentNode): HTMLElement => {
  const found = workspaceNotices(root);
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `Expected one workspace notice, found ${found.length}: ${found
      .map(titleOf)
      .join(' | ')}; the view reads: ${normalized(
      rendered?.root.textContent,
    ).slice(0, 400)}`,
  );
  return first;
};

/** The notice's Retry, when it offers one. */
const retryOf = (notice: HTMLElement): HTMLElement | undefined =>
  named(notice, 'button', 'Retry')[0];

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

/** The toasts sonner draws in the window. */
const toasts = (): Element[] => [
  ...document.querySelectorAll('[data-sonner-toast]'),
];

/** The project sidebar of the workspace frame. */
const projectSidebar = (workspace: RenderedWorkspace): HTMLElement => {
  const search = workspace.root.querySelector('[data-slot="thread-region"]');
  const sidebar = search?.closest<HTMLElement>('[data-slot="sidebar"]');
  assert.ok(sidebar, 'The workspace frame shows no project sidebar.');
  return sidebar;
};

/** The Thread row named `name`. */
const threadRow = (workspace: RenderedWorkspace, name: string): HTMLElement => {
  const found = [
    ...workspace.root.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ].find((row) => normalized(row.textContent).startsWith(name));
  assert.ok(found, `No Thread row ${name}.`);
  return found;
};

/** Double-clicks the Thread's name and answers its name field. */
const openThreadRename = async (
  workspace: RenderedWorkspace,
  name: string,
): Promise<HTMLElement> => {
  const label = [
    ...threadRow(workspace, name).querySelectorAll<HTMLElement>('span'),
  ].find(
    (span) =>
      span.getAttribute('data-slot') !== 'thread-lead' &&
      normalized(span.textContent) === name,
  );
  assert.ok(label, `The row ${name} shows no name.`);
  label.dispatchEvent(
    new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
  );
  await settle();
  return only(workspace.root, '[role="textbox"]', 'Thread name');
};

/** Types `name` into an open name field and presses Enter. */
const submitName = async (field: HTMLElement, name: string): Promise<void> => {
  field.textContent = name;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await key(field, { key: 'Enter' });
};

/** Replaces `navigator.clipboard` until the test ends. */
const useClipboard = (clipboard: Partial<Clipboard>): void => {
  const own = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: clipboard,
  });
  restores.push(() => {
    if (own === undefined) {
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    } else Object.defineProperty(navigator, 'clipboard', own);
  });
};

/** Silences `console.error` until the test ends (`ElementHost` logs a failure). */
const quietConsoleError = (): void => {
  const original = console.error;
  console.error = () => undefined;
  restores.push(() => {
    console.error = original;
  });
};

// T-27, T-28: the one workspace error and its Retry --------------------------

/**
 * A failed Projects load, then the reader opens a Project: the window starts
 * on the dashboard, where the mount load fails, and a navigation the layout
 * did not make opens the workspace frame. (At `/projects/<id>` the mount
 * load's failure would not land: the route's selection restore is a newer
 * intent.)
 */
const failedProjectsLoad = async (): Promise<RenderedWorkspace> => {
  const workspace = await renderFailing({ path: '/projects' }, ['projects']);
  await navigate(workspace, projectPath(project));
  return workspace;
};

describe('the workspace notice in the project sidebar (T-28)', () => {
  test('a failed Projects load shows "Projects not loaded" with Retry, not announced again after the frame switch; Retry loads again and the notice goes', async () => {
    const workspace = await failedProjectsLoad();

    const notice = workspaceNotice(projectSidebar(workspace));
    assert.equal(titleOf(notice), 'Projects not loaded');
    // The dashboard announced it; the sidebar's notice is the same error.
    assert.equal(notice.getAttribute('role'), 'group');
    assert.equal(notice.dataset.variant, 'block');
    const retry = retryOf(notice);
    assert.ok(retry, 'A failed Projects load offers no Retry.');

    let reads = 0;
    const records = recordsOf(workspace);
    let listed = records.projects();
    records.projects = () => listed;
    onReload(workspace, (input) => {
      if (input.target !== 'projects') return;
      reads += 1;
      listed = ready([project, docs]);
    });
    await click(retry);

    assert.equal(reads, 1, 'Retry did not load the Projects again.');
    assert.deepEqual(workspaceNotices(workspace.root).map(titleOf), []);
  });

  test('a failed Threads load shows "Threads not loaded", announced, with Retry; Retry loads that Project\'s Threads and the notice goes', async () => {
    const workspace = await renderFailing(
      {
        path: projectPath(project),
      },
      ['threads'],
    );

    const notice = workspaceNotice(projectSidebar(workspace));
    assert.equal(titleOf(notice), 'Threads not loaded');
    assert.equal(notice.getAttribute('role'), 'alert');
    const retry = retryOf(notice);
    assert.ok(retry, 'A failed Threads load offers no Retry.');

    const asked: string[] = [];
    const records = recordsOf(workspace);
    const own = records.threads.bind(records);
    const answered = new Map<string, RecordsRead<readonly Thread[]>>();
    records.threads = (projectId) => answered.get(projectId) ?? own(projectId);
    onReload(workspace, (input) => {
      if (input.target !== 'threads') return;
      asked.push(input.projectId);
      answered.set(input.projectId, ready([plan]));
    });
    await click(retry);

    assert.deepEqual(asked, [project.id]);
    assert.deepEqual(workspaceNotices(workspace.root).map(titleOf), []);
  });

  test('a Retry whose load fails again shows the notice again, with Retry', async () => {
    const workspace = await renderFailing(
      {
        path: '/projects',
      },
      ['projects'],
    );
    const retry = retryOf(workspaceNotice(workspace.root));
    assert.ok(retry, 'A failed Projects load offers no Retry.');

    await click(retry);

    const again = workspaceNotice(workspace.root);
    assert.equal(titleOf(again), 'Projects not loaded');
    assert.ok(retryOf(again), 'The repeated failure lost its Retry.');
  });
});

describe('retry targets and what clears them (T-27)', () => {
  test('a failed rename stores no target: "Change not saved" with no Retry', async () => {
    const workspace = await render({ path: projectPath(project) });
    recordsOf(workspace).renameThread = async () => {
      throw hostFailure();
    };

    const field = await openThreadRename(workspace, plan.name);
    await submitName(field, 'Plan v2');

    const notice = workspaceNotice(workspace.root);
    assert.equal(titleOf(notice), 'Change not saved');
    assert.equal(retryOf(notice), undefined, 'A failed write offers Retry.');
  });

  test('a failed thread-id copy stores no target: "Could not copy" with no Retry', async () => {
    useClipboard({
      writeText: () => Promise.reject(new Error('Clipboard access denied.')),
    });
    const workspace = await render({ path: projectPath(project) });

    threadRow(workspace, plan.name).dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    await settle();
    await click(
      only(
        document,
        '[data-slot="context-menu-content"] [role="menuitem"]',
        'Copy thread ID',
      ),
    );

    const notice = workspaceNotice(workspace.root);
    assert.equal(titleOf(notice), 'Could not copy');
    assert.ok(
      normalized(notice.textContent).includes('Unable to copy the thread ID.'),
      `The notice does not say what failed: ${normalized(notice.textContent)}`,
    );
    assert.equal(retryOf(notice), undefined, 'A failed copy offers Retry.');
  });

  test("another Project's Threads loading leaves a Threads error; its own Project's loading clears it", async () => {
    const workspace = await renderFailing(
      {
        path: projectPath(project),
      },
      ['threads'],
    );
    assert.equal(
      titleOf(workspaceNotice(workspace.root)),
      'Threads not loaded',
    );

    const loaded = new Set([docs.id]);
    const answers = new Map<string, RecordsRead<readonly Thread[]>>([
      [project.id, ready([plan])],
      [docs.id, ready([guide])],
    ]);
    const failed = failedRead<readonly Thread[]>();
    recordsOf(workspace).threads = (projectId) =>
      loaded.has(projectId) ? (answers.get(projectId) ?? failed) : failed;
    onReload(workspace);

    await navigate(workspace, projectPath(docs));
    assert.equal(
      titleOf(workspaceNotice(workspace.root)),
      'Threads not loaded',
      "Loading another Project's Threads cleared the error.",
    );

    loaded.add(project.id);
    await navigate(workspace, projectPath(project));
    assert.deepEqual(workspaceNotices(workspace.root).map(titleOf), []);
  });

  test('a Threads load leaves a Projects error', async () => {
    // Opening the Project loads its Threads, which succeeds.
    const workspace = await failedProjectsLoad();

    const notice = workspaceNotice(workspace.root);
    assert.equal(titleOf(notice), 'Projects not loaded');
    assert.ok(retryOf(notice), 'The Projects error lost its Retry.');
  });

  test('starting a create clears the error', async () => {
    const workspace = await failedProjectsLoad();
    assert.equal(workspaceNotices(workspace.root).length, 1);

    await click(only(workspace.root, 'button', 'New Thread'));

    assert.deepEqual(workspaceNotices(workspace.root).map(titleOf), []);
  });

  test('a Retry started after the reader acted stores its failure again', async () => {
    // The reader moved on (opened a Project) after the first load failed.
    const workspace = await failedProjectsLoad();
    const retry = retryOf(workspaceNotice(workspace.root));
    assert.ok(retry, 'The Projects error lost its Retry.');

    await click(retry);

    const again = workspaceNotice(workspace.root);
    assert.equal(titleOf(again), 'Projects not loaded');
    assert.ok(retryOf(again), 'The repeated failure lost its Retry.');
  });

  test('a reader action during a Retry keeps its failure from landing', async () => {
    const workspace = await failedProjectsLoad();
    const records = recordsOf(workspace);
    let listed = records.projects();
    records.projects = () => listed;
    onReload(workspace, (input) => {
      if (input.target === 'projects') listed = { status: 'loading' };
    });
    const retry = retryOf(workspaceNotice(workspace.root));
    assert.ok(retry, 'A failed Projects load offers no Retry.');

    await click(retry);
    assert.deepEqual(
      workspaceNotices(workspace.root).map(titleOf),
      [],
      'Retry did not clear the error first.',
    );

    await navigate(workspace, projectPath(docs));
    listed = failedRead();
    workspace.notifyRecords();
    await settle();

    assert.deepEqual(workspaceNotices(workspace.root).map(titleOf), []);
  });
});

// T-29: a rename's failures --------------------------------------------------

describe('a rename that fails (T-29)', () => {
  test('a refused request shows the workspace notice, keeps the mark, and no toast or text under the name', async () => {
    const workspace = await render({ path: projectPath(project) });
    recordsOf(workspace).renameThread = async () => {
      throw hostFailure();
    };

    const field = await openThreadRename(workspace, plan.name);
    await submitName(field, 'Plan v2');

    assert.equal(toasts().length, 0, 'A failed rename shows a toast.');
    assert.equal(
      workspace.root.querySelectorAll('p[role="alert"]').length,
      0,
      'A failed rename shows text under the name.',
    );
    const open = only(workspace.root, '[role="textbox"]', 'Thread name');
    assert.equal(open.getAttribute('aria-invalid'), 'true');
    assert.equal(
      titleOf(workspaceNotice(projectSidebar(workspace))),
      'Change not saved',
    );
  });

  test('an invalid name shows its reason under the name, and no toast or workspace notice', async () => {
    const workspace = await render({ path: projectPath(project) });

    const field = await openThreadRename(workspace, plan.name);
    await submitName(field, '   ');

    assert.equal(toasts().length, 0, 'A refused name shows a toast.');
    const reasons = [
      ...workspace.root.querySelectorAll<HTMLElement>('p[role="alert"]'),
    ];
    assert.deepEqual(
      reasons.map((reason) => normalized(reason.textContent)),
      ['Enter a name between 1 and 80 characters.'],
    );
    assert.ok(
      reasons[0]?.classList.contains('text-destructive'),
      'The reason is not drawn in the destructive color.',
    );
    assert.deepEqual(workspaceNotices(workspace.root).map(titleOf), []);
  });
});

// T-30, T-31: the dashboard ---------------------------------------------------

const DASHBOARD = 'aside[aria-label="Dashboard navigation"]';

describe('the dashboard (T-30, T-31)', () => {
  test('on /projects a workspace failure shows in the body, once, with Retry', async () => {
    const workspace = await renderFailing(
      {
        path: '/projects',
      },
      ['projects'],
    );

    const notice = workspaceNotice(workspace.root);
    assert.equal(titleOf(notice), 'Projects not loaded');
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.ok(notice.closest('main'), 'The notice is not in the body.');
    assert.equal(notice.closest(DASHBOARD), null);
    const retry = retryOf(notice);
    assert.ok(retry, 'The dashboard notice offers no Retry.');

    const records = recordsOf(workspace);
    let listed = records.projects();
    records.projects = () => listed;
    onReload(workspace, (input) => {
      if (input.target === 'projects') listed = ready([project, docs]);
    });
    await click(retry);

    assert.deepEqual(workspaceNotices(workspace.root).map(titleOf), []);
  });

  test('a failed projects list load shows an announced notice whose Retry refetches, busy while it runs', async () => {
    const workspace = await renderFailing(
      {
        path: '/projects',
      },
      ['activity'],
    );

    const notice = workspaceNotice(workspace.root);
    assert.equal(titleOf(notice), 'Projects not loaded');
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.equal(notice.dataset.variant, 'block');
    assert.ok(notice.closest('main'), 'The notice is not in the list area.');
    const retry = retryOf(notice);
    assert.ok(retry, 'The load failure offers no Retry.');

    const answer = deferred<readonly ProjectActivity[]>();
    let reads = 0;
    recordsOf(workspace).activity = () => {
      reads += 1;
      return answer.promise;
    };
    await click(retry);

    assert.equal(reads, 1, 'Retry did not refetch the projects list.');
    const busy = retryOf(workspaceNotice(workspace.root));
    assert.equal(busy?.getAttribute('aria-busy'), 'true');
    assert.equal(busy?.hasAttribute('disabled'), true);

    answer.resolve([{ project, activityAt: project.updatedAt }]);
    await settle();

    assert.deepEqual(workspaceNotices(workspace.root).map(titleOf), []);
    const list = workspace.root.querySelector('main');
    assert.ok(
      normalized(list?.textContent).includes(project.name),
      'The refetched list does not show the Project.',
    );
  });
});

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

/** The quarantine notices under `root`: the notices in the warning tone. */
const quarantineNotices = (root: ParentNode): HTMLElement[] =>
  notices(root).filter((notice) => notice.dataset.tone === 'warning');

/** Checks the one quarantine notice's look and answers it. */
const assertQuarantineNotice = async (
  workspace: RenderedWorkspace,
): Promise<HTMLElement> => {
  const found = quarantineNotices(document);
  const [notice] = found;
  assert.ok(
    found.length === 1 && notice !== undefined,
    `Expected one quarantine notice in the window, found ${found.length}.`,
  );
  assert.ok(workspace.root.contains(notice));
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
  test("the workspace frame shows it once, as the project sidebar content's last child, after the stack panes", async () => {
    const workspace = await render({
      path: projectPath(project),
      catalog: twoQuarantined,
    });

    const notice = await assertQuarantineNotice(workspace);
    const content = projectSidebar(workspace).querySelector(
      '[data-slot="sidebar-content"]',
    );
    assert.ok(content, 'The project sidebar has no content.');
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

  test('the dashboard frame shows it once, directly above the footer that holds "All settings"', async () => {
    const workspace = await render({
      path: '/projects',
      catalog: twoQuarantined,
    });

    const notice = await assertQuarantineNotice(workspace);
    const aside = workspace.root.querySelector(DASHBOARD);
    assert.ok(aside?.contains(notice), 'The notice is not in the sidebar.');
    // From step 4(a) change 7 the frame draws the notice, then the slot
    // `shell.sidebar.footer` (a `<core-region>`), which holds the footer.
    const footer = notice.nextElementSibling;
    assert.ok(
      normalized(footer?.textContent).includes('All settings'),
      'The footer below the notice does not hold "All settings".',
    );
  });

  test('without a quarantined bundle, or without the catalog, neither frame shows it', async () => {
    const healthy = catalogOf([
      catalogBundle('layout', '3.1.0', 'active'),
      catalogBundle('usage', '1.0.0', 'disabled'),
    ]);
    for (const path of [projectPath(project), '/projects']) {
      const withCatalog = await render({ path, catalog: healthy });
      assert.deepEqual(quarantineNotices(withCatalog.root), [], path);
      withCatalog.cleanup();

      const withoutCatalog = await render({ path });
      assert.deepEqual(quarantineNotices(withoutCatalog.root), [], path);
      withoutCatalog.cleanup();
    }
  });
});

// T-34: ElementHost -----------------------------------------------------------

/** The tag of the stack pane's action element, which `ElementHost` mounts. */
const PANE_ACTION = 'screen-group-action';

describe('ElementHost (T-34)', () => {
  test('when ui.create throws it shows a compact, announced "View failed to open" naming the element', async () => {
    quietConsoleError();
    const workspace = await render({ path: projectPath(project) });
    const ui = workspace.services.use(UiV1) as unknown as {
      create: (tag: string, props?: unknown) => unknown;
    };
    const create = ui.create;
    ui.create = (tag, props) => {
      if (tag === PANE_ACTION) throw new Error('define() was never called');
      return create(tag, props);
    };
    await workspace.remount();

    const notice = workspaceNotice(workspace.root);
    assert.equal(titleOf(notice), 'View failed to open');
    assert.equal(notice.dataset.variant, 'compact');
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.ok(
      notice.closest('[data-pane-id]'),
      'The notice is not where the element would be.',
    );
    assert.equal(retryOf(notice), undefined, 'The notice offers Retry.');
    const details = await detailsOf(notice);
    assert.ok(details.includes(`Element: ${PANE_ACTION}`), details);
  });

  test('an element that is answered, or answered as <core-unavailable>, shows no notice', async () => {
    const workspace = await render({
      path: projectPath(project),
      catalog: catalogOf([
        catalogBundle('screen', '1.0.0', 'quarantined', [
          { code: 'activate_failed', message: 'activate() threw: boom' },
        ]),
      ]),
    });
    assert.deepEqual(workspaceNotices(workspace.root).map(titleOf), []);

    const ui = workspace.services.use(UiV1) as unknown as {
      create: (tag: string, props?: unknown) => unknown;
    };
    const create = ui.create;
    ui.create = (tag, props) => {
      if (tag !== PANE_ACTION) return create(tag, props);
      const unavailable = document.createElement('core-unavailable');
      unavailable.hidden = true;
      return unavailable;
    };
    await workspace.remount();

    const pane = workspace.root.querySelector('[data-pane-id]');
    assert.ok(pane, 'The fixture shows no stack pane.');
    assert.equal(
      pane.querySelectorAll('core-unavailable').length,
      1,
      'The unavailable element is not mounted.',
    );
    assert.deepEqual(notices(pane), []);
    assert.deepEqual(workspaceNotices(workspace.root).map(titleOf), []);
  });
});
