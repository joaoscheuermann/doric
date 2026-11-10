// The Files tree's row menus (§4.4 A8–A10; T-4.4.1 for A8–A10, T-4.4.10,
// T-4.4.11, T-4.4.16), as the reader meets them in the Files view:
// - a file row's menu holds "Copy relative path", which copies the path
//   relative to the tree's root, the Thread's working directory (A8);
// - a folder row's menu holds "New file" and "New folder" (A9, A10): the
//   folder opens and an inline name row shows as its first child; Enter sends
//   the trimmed name to `files/v1.createFile` / `createDirectory` of the
//   Project; `created` closes the row and requests a refresh of the Project
//   (`files.refresh/v1`), after which the new row is listed (T-4.4.10);
// - every non-success answer shows its text under the name row, which stays
//   open with the typed name and requests no refresh (T-4.4.11);
// - Escape, blur and an empty name cancel without a call; while a call runs
//   the input is read-only and a blur does not cancel it;
// - with no menu open, no control is named "Copy relative path", "New file"
//   or "New folder" (T-4.4.16: an app whose `FileTree` draws no row menu
//   leaves the view working without them).

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type {
  CreateInput,
  CreateOutcome,
  LeaseOutcome,
  ProjectTreeNode,
  TreeObservation,
} from '../../src/contracts/index.js';
import { type Rendered, render, settle } from './support/render.js';

let rendered: Rendered | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

/** One call the view made to `files/v1`. */
type WriteCall = {
  readonly method: 'createFile' | 'createDirectory';
  readonly projectId: unknown;
  readonly input: CreateInput;
};

type Answer = (input: CreateInput) => Promise<LeaseOutcome<CreateOutcome>>;

type Setup = {
  /** The Thread's working directory: the tree's root. */
  readonly cwd?: string;
  /** The directories open when the view renders. */
  readonly open?: ReadonlySet<string>;
  /** The tree the host lists before a refresh. */
  readonly tree?: readonly ProjectTreeNode[];
  /** The tree the host lists after a refresh. */
  readonly refreshed?: readonly ProjectTreeNode[];
};

type Harness = {
  readonly view: Rendered;
  readonly calls: WriteCall[];
  readonly requests: string[];
  readonly copied: string[];
  /** What `files/v1` answers the next create; settable between calls. */
  answer: Answer;
};

const created = (path: string): LeaseOutcome<CreateOutcome> => ({
  status: 'ready',
  value: { status: 'created', path },
});

const setup = async ({
  cwd = '/workspace',
  open,
  tree,
  refreshed,
}: Setup = {}): Promise<Harness> => {
  const calls: WriteCall[] = [];
  const requests: string[] = [];
  const copied: string[] = [];
  const harness = {
    calls,
    requests,
    copied,
    answer: (async (input) =>
      created(`${input.directory}/${input.name}`)) as Answer,
  };
  const view = await render(async () => {
    const { createElement } = await import('react');
    const { SidebarScope } = await import('desktop/ui/sidebar');
    const { FilesTreeView } = await import(
      '../../src/client/tree/files-tree.js'
    );
    const { createQueryClient, rootOf } = await import(
      '../../src/client/sandbox-store.js'
    );
    const { setFilesClient } = await import('../../src/client/state.js');
    const { seedExpansion } = await import(
      '../../stories/support/files-client.js'
    );
    const fixtures = await import('../../stories/support/fixtures.js');
    const { still, storyServices } = await import(
      '../../stories/support/services.js'
    );

    let listed = tree ?? fixtures.workspaceTree;
    const observation = (): TreeObservation => ({
      read: { status: 'ready', value: listed },
      fetching: false,
    });
    const listeners = new Set<(state: TreeObservation) => void>();
    setFilesClient({
      store: {
        client: createQueryClient(),
        observeTree: (_scope, listener) => {
          listeners.add(listener);
          listener(observation());
          return { dispose: () => listeners.delete(listener) };
        },
        refresh: async () => undefined,
        dispose: () => undefined,
      },
      coordinator: {
        register: () => ({ dispose: () => undefined }),
        request: (projectId) => {
          requests.push(projectId);
          if (refreshed === undefined) return;
          listed = refreshed;
          for (const listener of listeners) listener(observation());
        },
        setWorkspace: () => undefined,
        dispose: () => undefined,
      },
    });
    seedExpansion(
      fixtures.project.id,
      rootOf(cwd),
      open ?? fixtures.openDirectories,
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    const write =
      (method: WriteCall['method'], projectId: unknown) =>
      (input: CreateInput) => {
        calls.push({ method, projectId, input });
        return harness.answer(input);
      };
    const services = storyServices({
      apis: {
        'layout.workspace/v1': {
          ...still,
          selection: () => ({
            project: fixtures.project,
            thread: { ...fixtures.thread, cwd },
          }),
        },
        'layout.tabs/v1': { ...still, current: () => undefined },
        'commands/v1': { execute: async () => undefined },
      },
      scoped: {
        'files/v1': (scope) => ({
          createFile: write('createFile', scope?.projectId),
          createDirectory: write('createDirectory', scope?.projectId),
        }),
      },
    });
    return createElement(
      SidebarScope,
      null,
      createElement(FilesTreeView, { services }),
    );
  });
  rendered = view;
  return Object.assign(harness, { view });
};

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** The tree's row named `name`. */
const row = (name: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    `[role="tree"] [role="treeitem"][aria-label="${name}"]`,
  );
  assert.ok(found, `No row named ${name}.`);
  return found;
};

const hasRow = (name: string): boolean =>
  document.querySelector(
    `[role="tree"] [role="treeitem"][aria-label="${name}"]`,
  ) !== null;

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

const entries = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-slot="context-menu-content"] [role="menuitem"]',
  ),
];

const labels = (): string[] =>
  entries().map((entry) => normalized(entry.textContent));

const pick = async (label: string): Promise<void> => {
  const entry = entries().find(
    (item) => normalized(item.textContent) === label,
  );
  assert.ok(
    entry,
    `No entry "${label}"; the menu holds ${labels().join(' | ')}`,
  );
  entry.click();
  await settle();
};

const nameInput = (kind: 'file' | 'folder'): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(
    `input[aria-label="New ${kind} name"]`,
  );

const type = async (input: HTMLInputElement, text: string): Promise<void> => {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setValue?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
};

const press = async (input: HTMLInputElement, key: string): Promise<void> => {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
  await settle();
};

/** The texts drawn in the name row's list item, below the input. */
const pendingText = (input: HTMLInputElement): string =>
  normalized(input.closest('li')?.textContent);

/** Opens "New file" or "New folder" on the folder row `folder`. */
const begin = async (
  folder: string,
  entry: 'New file' | 'New folder',
): Promise<HTMLInputElement> => {
  await openMenu(row(folder));
  await pick(entry);
  const input = nameInput(entry === 'New file' ? 'file' : 'folder');
  assert.ok(input, `No name row after ${entry}.`);
  return input;
};

const file = (path: string): ProjectTreeNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'file',
  size: 0,
});

/** `tree` with `node` added to the children of the directory `directory`. */
const withChild = (
  tree: readonly ProjectTreeNode[],
  directory: string,
  node: ProjectTreeNode,
): ProjectTreeNode[] =>
  tree.map((entry) =>
    entry.type !== 'directory'
      ? entry
      : entry.path === directory
        ? { ...entry, children: [node, ...(entry.children ?? [])] }
        : {
            ...entry,
            children: withChild(entry.children ?? [], directory, node),
          },
  );

describe('the row menus', () => {
  test('a file row holds Copy relative path; a folder row New file and New folder', async () => {
    await setup();

    await openMenu(row('README.md'));
    assert.deepEqual(labels(), ['Copy relative path']);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();

    await openMenu(row('checkout'));
    assert.deepEqual(labels(), ['New file', 'New folder']);
  });

  test('with no menu open no control is named for a menu entry (T-4.4.16)', async () => {
    const { view } = await setup();

    const text = normalized(view.root.textContent);
    for (const name of ['Copy relative path', 'New file', 'New folder']) {
      assert.ok(!text.includes(name), `"${name}" is drawn without a menu`);
    }
    assert.equal(document.querySelectorAll('[role="menuitem"]').length, 0);
    assert.equal(document.querySelectorAll('input').length, 0);
    assert.ok(hasRow('payment-form.tsx'), 'the tree still lists its rows');
  });
});

describe('A8 Copy relative path', () => {
  test('copies the path relative to the workspace root', async () => {
    const { copied } = await setup();

    await openMenu(row('payment-form.tsx'));
    await pick('Copy relative path');

    assert.deepEqual(copied, ['apps/web/src/checkout/payment-form.tsx']);
  });

  test('copies the path relative to the Thread working directory below the root', async () => {
    const fixtures = await import('../../stories/support/fixtures.js');
    const { copied } = await setup({
      cwd: '/workspace/apps/web',
      tree: fixtures.webTree,
      open: new Set(['apps/web/src']),
    });

    await openMenu(row('main.tsx'));
    await pick('Copy relative path');

    assert.deepEqual(copied, ['src/main.tsx']);
  });
});

describe('A9 New file', () => {
  test('opens the folder, creates the trimmed name in it, refreshes the Project and lists the new row', async () => {
    const fixtures = await import('../../stories/support/fixtures.js');
    const harness = await setup({
      refreshed: withChild(
        fixtures.workspaceTree,
        'packages/pricing',
        file('packages/pricing/rates.ts'),
      ),
    });
    assert.ok(!hasRow('rates.ts'), 'precondition');
    assert.equal(row('pricing').getAttribute('aria-expanded'), 'false');

    const input = await begin('pricing', 'New file');

    assert.equal(row('pricing').getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, input, 'the name row has focus');
    const sub = row('pricing').closest('li')?.querySelector('[role="group"]');
    assert.ok(
      sub?.firstElementChild?.contains(input),
      'first child of the folder',
    );

    await type(input, '  rates.ts  ');
    await press(input, 'Enter');

    assert.deepEqual(harness.calls, [
      {
        method: 'createFile',
        projectId: 'prj_checkout',
        input: { directory: 'packages/pricing', name: 'rates.ts' },
      },
    ]);
    assert.deepEqual(harness.requests, ['prj_checkout']);
    assert.equal(nameInput('file'), null, 'the name row closes');
    assert.ok(hasRow('rates.ts'), 'the new row is listed');
  });

  test('Escape, blur and an empty name cancel without a call', async () => {
    const harness = await setup();

    let input = await begin('checkout', 'New file');
    await type(input, 'draft.ts');
    await press(input, 'Escape');
    assert.equal(nameInput('file'), null, 'Escape closes the row');

    input = await begin('checkout', 'New file');
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('blur'));
    await settle();
    assert.equal(nameInput('file'), null, 'blur closes the row');

    input = await begin('checkout', 'New file');
    await type(input, '   ');
    await press(input, 'Enter');
    assert.equal(nameInput('file'), null, 'an empty name closes the row');

    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.requests, []);
  });

  test('while the call runs the input is read-only and a blur does not cancel it', async () => {
    const harness = await setup();
    let finish: (outcome: LeaseOutcome<CreateOutcome>) => void = () =>
      undefined;
    harness.answer = () =>
      new Promise((done) => {
        finish = done;
      });

    const input = await begin('checkout', 'New file');
    await type(input, 'steps.ts');
    await press(input, 'Enter');

    assert.equal(input.readOnly, true);
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('blur'));
    await settle();
    assert.equal(nameInput('file'), input, 'the row stays while the call runs');

    finish(created('apps/web/src/checkout/steps.ts'));
    await settle();
    assert.equal(nameInput('file'), null);
    assert.deepEqual(harness.requests, ['prj_checkout']);
  });
});

describe('A10 New folder', () => {
  test('creates a directory in an empty folder, its name row replacing the empty notice', async () => {
    const harness = await setup({ open: new Set(['docs']) });
    assert.ok(
      normalized(document.body.textContent).includes(
        'This directory is empty.',
      ),
      'precondition',
    );

    const input = await begin('docs', 'New folder');

    assert.ok(
      !normalized(document.body.textContent).includes(
        'This directory is empty.',
      ),
      'the name row replaces the empty notice',
    );
    await type(input, 'guides');
    await press(input, 'Enter');

    assert.deepEqual(harness.calls, [
      {
        method: 'createDirectory',
        projectId: 'prj_checkout',
        input: { directory: 'docs', name: 'guides' },
      },
    ]);
    assert.deepEqual(harness.requests, ['prj_checkout']);
    assert.equal(nameInput('folder'), null);
  });
});

describe('non-success answers (T-4.4.11)', () => {
  const refused =
    (reason: 'exists' | 'invalid-name' | 'outside' | 'no-directory'): Answer =>
    async () => ({ status: 'ready', value: { status: 'refused', reason } });

  const rows: readonly (readonly [string, Answer, string])[] = [
    ['refused exists', refused('exists'), 'steps.ts already exists.'],
    [
      'refused invalid-name',
      refused('invalid-name'),
      'A name cannot contain / or \\, cannot be . or .., and has at most 255 bytes.',
    ],
    [
      'refused outside',
      refused('outside'),
      'This folder is outside the Project.',
    ],
    [
      'refused no-directory',
      refused('no-directory'),
      'This folder no longer exists.',
    ],
    [
      'failed',
      async () => ({
        status: 'ready',
        value: { status: 'failed', message: 'mkdir: Read-only file system' },
      }),
      'mkdir: Read-only file system',
    ],
    [
      'lease pending',
      async () => ({ status: 'pending' }),
      'The Project is starting. Try again in a moment.',
    ],
    [
      'lease unavailable',
      async () => ({ status: 'unavailable' }),
      'The Project is unavailable.',
    ],
    [
      'lease expired',
      async () => ({ status: 'expired' }),
      "The Project's sandbox expired. Reopen the Project.",
    ],
    [
      'lease missing',
      async () => ({ status: 'missing' }),
      'The Project no longer exists.',
    ],
    [
      'the call throws',
      async () => {
        throw new Error('bridge closed');
      },
      'Could not create steps.ts.',
    ],
  ];

  for (const kind of ['New file', 'New folder'] as const) {
    test(`${kind}: each answer shows its text under the name row, which stays open`, async () => {
      const harness = await setup();
      const input = await begin('checkout', kind);
      await type(input, ' steps.ts ');

      for (const [answer, outcome, text] of rows) {
        harness.answer = outcome;
        await press(input, 'Enter');

        assert.ok(
          pendingText(input).includes(text),
          `${answer}: "${text}" not under the name row (${pendingText(input)})`,
        );
        assert.equal(
          input.value,
          ' steps.ts ',
          `${answer}: keeps the typed name`,
        );
        assert.equal(input.readOnly, false, `${answer}: editable again`);
        assert.ok(input.isConnected, `${answer}: the row stays open`);
      }
      assert.equal(harness.calls.length, rows.length);
      assert.deepEqual(harness.requests, [], 'a refusal requests no refresh');
    });
  }
});
