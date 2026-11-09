// Discard in the Changes view (ui-redesign §4.4 A11, A12; T-4.4.1 for A11 and
// A12, T-4.4.10, T-4.4.11, T-4.4.14, T-4.4.16), as the reader meets it:
// - a changed file's row has a context menu with "Discard changes"; directory
//   rows have none; the repository row's menu holds "Discard all changes";
// - either entry opens a confirmation that names its target and says it
//   cannot be undone; Cancel changes nothing;
// - confirming sends `git.commands/v1.discard` for that path, or for the
//   whole repository without `paths`, and the dialog closes only once the
//   Project's refresh settled, so the tree no longer lists what was discarded;
// - every non-success answer shows its text in the dialog, which stays open;
// - with no menu open, no control is named for a Discard.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { GitApi } from '../../src/client/api/git-api.js';
import type { FilesRefresh } from '../../src/client/api/peers.js';
import type { Discard, ProjectChanges } from '../../src/contracts/index.js';
import { type Rendered, render, settle } from './support/render.js';

type DiscardInput = Parameters<GitApi['discard']>[0];

const PROJECT = 'project-storefront';
const THREAD = 'thread-checkout-totals';
const CHECKOUT = 'src/components/Checkout.tsx';

let rendered: Rendered | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** A promise and the function that settles it. */
const deferred = () => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
};

interface Workspace {
  /** What `discard` was asked, in order. */
  readonly discards: DiscardInput[];
  /** The Project ids the files refresh coordinator was asked to refresh. */
  readonly refreshes: string[];
  /** Changes reads asked after the first one. */
  rereads: number;
}

/**
 * The Changes view over a fake host whose changes read answers `current()`
 * and whose `discard` answers `answer(input)`. `gate`, when set, holds every
 * changes read after the first until it is released.
 */
const renderChanges = async (options: {
  readonly answer?: (input: DiscardInput) => Promise<Discard>;
  readonly current?: () => ProjectChanges;
  readonly gate?: Promise<void>;
}): Promise<Workspace> => {
  const workspace: Workspace = { discards: [], refreshes: [], rereads: 0 };
  const { changes } = await import('../../stories/support/fixtures.js');
  let reads = 0;
  rendered = await render(async () => {
    const { createElement } = await import('react');
    const { GitChangesView } = await import(
      '../../src/client/changes/git-changes.js'
    );
    const { fakeGitApi, GitHarness, readyTree, windowServices } = await import(
      '../../stories/support/git-harness.js'
    );
    const refresh: FilesRefresh = {
      register: () => ({ dispose: () => undefined }),
      request: (projectId) => {
        workspace.refreshes.push(projectId);
      },
    };
    const api = fakeGitApi({
      changes: async () => {
        reads += 1;
        if (reads > 1) {
          workspace.rereads += 1;
          await options.gate;
        }
        return { status: 'ready', changes: options.current?.() ?? changes };
      },
      discard: async (input) => {
        workspace.discards.push(input);
        return (
          options.answer?.(input) ??
          Promise.resolve({ status: 'ready', value: { discarded: [] } })
        );
      },
    });
    return createElement(
      GitHarness,
      { api, refresh },
      createElement(GitChangesView, {
        services: windowServices({ tree: readyTree }),
      }),
    );
  });
  return workspace;
};

/** The tree row named `name`, a file, directory or repository row. */
const row = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
    (item) => {
      const label = item.getAttribute('aria-label') ?? '';
      return label === name || label.startsWith(`${name},`);
    },
  );

const rowOf = (name: string): HTMLElement => {
  const found = row(name);
  assert.ok(found, `No tree row named ${name}.`);
  return found;
};

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

const menu = (): Element | null =>
  document.querySelector('[data-slot="context-menu-content"]');

/** The open menu's entries, in order. */
const entries = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-slot="context-menu-content"] [role="menuitem"]',
  ),
];

const pick = async (label: string): Promise<void> => {
  const entry = entries().find(
    (item) => normalized(item.textContent) === label,
  );
  assert.ok(
    entry,
    `No entry "${label}"; the menu holds ${entries()
      .map((item) => normalized(item.textContent))
      .join(' | ')}`,
  );
  entry.click();
  await settle();
};

/** Waits until `ready()` holds: a refresh starts after the store's 250 ms batching. */
const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}.`);
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  await settle();
};

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="alertdialog"]');

const dialogText = (): string => normalized(dialog()?.textContent);

const press = async (label: string): Promise<void> => {
  const open = dialog();
  assert.ok(open, 'No Discard dialog is open.');
  const button = [...open.querySelectorAll<HTMLElement>('button')].find(
    (item) => normalized(item.textContent) === label,
  );
  assert.ok(button, `No button "${label}" in the dialog: ${dialogText()}`);
  button.click();
  await settle();
};

/** Opens A11's dialog for Checkout.tsx. */
const discardCheckout = async (): Promise<void> => {
  await openMenu(rowOf('Checkout.tsx'));
  await pick('Discard changes');
};

/** The fixture's changes without `paths` of the workspace repository. */
const without = async (
  ...paths: readonly string[]
): Promise<ProjectChanges> => {
  const { changes } = await import('../../stories/support/fixtures.js');
  return {
    repositories: changes.repositories.map((repository) => ({
      ...repository,
      changes: repository.changes.filter(
        (change) => !paths.includes(change.path),
      ),
    })),
  };
};

describe('A11 Discard changes on a changed file', () => {
  test('confirming discards that path and the row leaves the tree', async () => {
    let discarded = false;
    const after = await without(CHECKOUT);
    const { changes } = await import('../../stories/support/fixtures.js');
    const workspace = await renderChanges({
      current: () => (discarded ? after : changes),
      answer: async () => {
        discarded = true;
        return { status: 'ready', value: { discarded: [CHECKOUT] } };
      },
    });

    await discardCheckout();
    assert.match(dialogText(), /Discard changes to Checkout\.tsx\?/);
    assert.match(dialogText(), /This cannot be undone\./);
    await press('Discard');
    await waitFor(() => dialog() === null, 'the dialog to close');

    assert.deepEqual(workspace.discards, [
      {
        threadId: THREAD,
        cwd: '/workspace',
        repository: '',
        paths: [CHECKOUT],
      },
    ]);
    assert.ok(dialog() === null, 'the dialog closed');
    assert.ok(row('Checkout.tsx') === undefined, 'the row is gone');
    assert.ok(row('pricing.ts'), 'the other changes stay listed');
  });

  test('Cancel discards nothing and keeps the row', async () => {
    const workspace = await renderChanges({});

    await discardCheckout();
    await press('Cancel');

    assert.deepEqual(workspace.discards, []);
    assert.ok(dialog() === null, 'the dialog closed');
    assert.ok(row('Checkout.tsx'));
  });

  test('a directory row of the Changes tree has no menu', async () => {
    await renderChanges({});

    await openMenu(rowOf('components'));

    assert.ok(menu() === null, 'no menu opened');
  });
});

describe('A12 Discard all changes on a repository row (T-4.4.14)', () => {
  test('the repository row opens "Discard all changes", which discards the whole repository', async () => {
    let discarded = false;
    const { changes } = await import('../../stories/support/fixtures.js');
    const workspace = await renderChanges({
      current: () => (discarded ? { repositories: [] } : changes),
      answer: async () => {
        discarded = true;
        return { status: 'ready', value: { discarded: [CHECKOUT] } };
      },
    });

    await openMenu(rowOf('workspace'));
    assert.deepEqual(
      entries().map((item) => normalized(item.textContent)),
      ['Discard all changes'],
    );
    await pick('Discard all changes');
    assert.match(dialogText(), /Discard all changes in workspace\?/);
    assert.match(dialogText(), /This cannot be undone\./);
    await press('Discard');
    await waitFor(() => dialog() === null, 'the dialog to close');

    assert.deepEqual(workspace.discards, [
      { threadId: THREAD, cwd: '/workspace', repository: '' },
    ]);
    assert.ok(dialog() === null, 'the dialog closed');
    assert.ok(row('workspace') === undefined, 'no changed repository is left');
  });
});

describe('refresh after a Discard (T-4.4.10)', () => {
  for (const [name, answer] of [
    ['ready', { status: 'ready', value: { discarded: [CHECKOUT] } }],
    [
      'failed',
      {
        status: 'failed',
        message: 'error: unable to unlink Checkout.tsx',
        discarded: [],
      },
    ],
  ] as const) {
    test(`after "${name}" the dialog waits for the Project's refresh to settle`, async () => {
      const gate = deferred();
      const workspace = await renderChanges({
        gate: gate.promise,
        answer: async () => answer,
      });

      await discardCheckout();
      await press('Discard');
      await waitFor(
        () => workspace.rereads > 0,
        'the changes to be read again',
      );

      assert.deepEqual(workspace.refreshes, [PROJECT]);
      assert.ok(dialog(), 'the dialog stays while the refresh runs');
      assert.doesNotMatch(dialogText(), /unable to unlink/);

      gate.release();
      await waitFor(
        () => dialog() === null || dialogText().includes('unable to unlink'),
        'the Discard to finish',
      );

      if (name === 'ready') assert.ok(dialog() === null, 'the dialog closed');
      else assert.match(dialogText(), /error: unable to unlink Checkout\.tsx/);
    });
  }
});

describe('Discard answers in the dialog (T-4.4.11)', () => {
  const rows: readonly (readonly [string, () => Promise<Discard>, string])[] = [
    [
      'refused',
      async () => ({
        status: 'refused',
        message: `${CHECKOUT} has a merge conflict. Resolve it before discarding.`,
      }),
      `${CHECKOUT} has a merge conflict. Resolve it before discarding.`,
    ],
    [
      'failed',
      async () => ({
        status: 'failed',
        message: `${CHECKOUT} still has changes after Discard.`,
        discarded: [],
      }),
      `${CHECKOUT} still has changes after Discard.`,
    ],
    [
      'missing',
      async () => ({ status: 'missing' }),
      'This Thread no longer exists.',
    ],
    [
      'inactive',
      async () => ({ status: 'inactive' }),
      'This Thread is not running. Open it and try again.',
    ],
    [
      'pending',
      async () => ({ status: 'pending' }),
      'The Project is starting. Try again in a moment.',
    ],
    [
      'the call throws',
      async () => {
        throw new Error('Doric backend is unavailable.');
      },
      'Could not discard the changes.',
    ],
  ];
  for (const [name, answer, text] of rows) {
    test(`${name}: "${text}" shows in the dialog, which stays open until Cancel`, async () => {
      await renderChanges({ answer });

      await discardCheckout();
      await press('Discard');
      await waitFor(
        () => !dialogText().includes('Discarding…'),
        'the Discard to finish',
      );

      assert.ok(dialog(), 'the dialog stays open');
      assert.ok(
        dialogText().includes(text),
        `"${text}" is not in the dialog: ${dialogText()}`,
      );
      await press('Cancel');
      assert.ok(dialog() === null, 'the dialog closed');
    });
  }
});

describe('without an open menu (T-4.4.16)', () => {
  test('no control in the Changes view is named for a Discard', async () => {
    await renderChanges({});

    assert.ok(row('Checkout.tsx'), 'the view works');
    const named = [
      ...document.querySelectorAll<HTMLElement>(
        'button, [role="button"], [role="menuitem"]',
      ),
    ].filter((control) =>
      /^Discard (all )?changes$/.test(
        normalized(
          control.getAttribute('aria-label') ?? control.textContent ?? '',
        ),
      ),
    );
    assert.deepEqual(
      named.map((control) => normalized(control.textContent)),
      [],
    );
    assert.ok(menu() === null, 'no menu opened');
  });
});
