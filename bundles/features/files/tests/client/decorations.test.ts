// The Files tree's marks (bundle isolation 9, T9.1, AC9.1): `files` declares
// `files.decorations/v1` and draws what every provider of it answers, with no
// file of `files` naming the provider. Here the providers are made up:
// - a provider's marks are drawn on their rows: the row reads
//   `name, description`, a file's badge shows its letter and a directory's its
//   count; the provider is asked for the tree the view shows, the Project and
//   the selected Thread's working directory;
// - with no provider, no row is decorated, even where git's own changes read
//   (`git.changes/v1`) is served;
// - the marks of two providers merge; for a path both mark, the mark of the
//   provider with the smaller bundle id is drawn, whichever registered first;
// - a provider's error is shown in the panel's read toast, and the other
//   providers' marks are still drawn.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type {
  DecorationsObservation,
  FileMark,
  TreeObservation,
  TreeScope,
} from '../../src/contracts/index.js';
import { type Rendered, render, settle } from './support/render.js';
import { selectionApis } from './support/selection.js';

let rendered: Rendered | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

/** The Thread's working directory: the tree is rooted at `apps/web`. */
const cwd = '/workspace/apps/web';

/** A made-up provider of `files.decorations/v1`: what it answers every scope. */
type Provider = {
  readonly bundleId: string;
  readonly answer: DecorationsObservation;
};

type Harness = {
  readonly projectId: string;
  /** The scopes each provider was asked for, by bundle id. */
  readonly asked: ReadonlyMap<string, readonly TreeScope[]>;
};

/**
 * Renders the Files view of the Project's tree rooted at `cwd`, with its
 * directories open, the providers registered in the order given, and a
 * `Toaster` beside it that draws the panel's read toast.
 */
const setup = async (
  providers: readonly Provider[] = [],
  apis: Readonly<Record<string, unknown>> = {},
): Promise<Harness> => {
  const asked = new Map<string, TreeScope[]>(
    providers.map(({ bundleId }) => [bundleId, []]),
  );
  let projectId = '';
  const view = await render(async () => {
    const { createElement, Fragment } = await import('react');
    const { SidebarScope } = await import('desktop/ui/sidebar');
    const { Toaster } = await import('desktop/ui/sonner');
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

    projectId = fixtures.project.id;
    const tree: TreeObservation = {
      read: { status: 'ready', value: fixtures.webTree },
      fetching: false,
    };
    setFilesClient({
      store: {
        client: createQueryClient(),
        observeTree: (_scope, listener) => {
          listener(tree);
          return { dispose: () => undefined };
        },
        refresh: async () => undefined,
        dispose: () => undefined,
      },
      coordinator: {
        register: () => ({ dispose: () => undefined }),
        request: () => undefined,
        setWorkspace: () => undefined,
        dispose: () => undefined,
      },
    });
    seedExpansion(
      fixtures.project.id,
      rootOf(cwd),
      new Set(['apps/web/src', 'apps/web/src/checkout']),
    );
    const services = storyServices({
      apis: {
        ...selectionApis(fixtures.project, { ...fixtures.thread, cwd }),
        'layout.tabs/v2': { ...still, current: () => undefined },
        'commands/v1': { execute: async () => undefined },
        ...apis,
      },
      many: {
        'files.decorations/v1': providers.map(({ bundleId, answer }) => ({
          bundleId,
          api: {
            observe: (
              scope: TreeScope,
              listener: (state: DecorationsObservation) => void,
            ) => {
              asked.get(bundleId)?.push(scope);
              listener(answer);
              return { dispose: () => undefined };
            },
          },
        })),
      },
    });
    return createElement(
      Fragment,
      null,
      createElement(
        SidebarScope,
        null,
        createElement(FilesTreeView, { services }),
      ),
      createElement(Toaster),
    );
  });
  rendered = view;
  // The toast draws after the view's first answers.
  await settle();
  return { projectId, asked };
};

const answer = (
  marks: DecorationsObservation['marks'],
  extra: Partial<DecorationsObservation> = {},
): DecorationsObservation => ({ marks, fetching: false, ...extra });

const fileMark = (description: string, letter: string): FileMark => ({
  description,
  count: 1,
  letter,
});

const directoryMark = (description: string, count: number): FileMark => ({
  description,
  count,
});

const paymentForm = 'apps/web/src/checkout/payment-form.tsx';
const shippingStep = 'apps/web/src/checkout/shipping-step.tsx';

/** The tree's rows, by the name each one reads. */
const rowLabels = (): string[] =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[role="tree"] [role="treeitem"]',
    ),
  ].map((row) => row.getAttribute('aria-label') ?? '');

/** The tree's row that reads `label`. */
const row = (label: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    `[role="tree"] [role="treeitem"][aria-label="${label}"]`,
  );
  assert.ok(found, `No row reads "${label}"; the rows read ${rowLabels()}`);
  return found;
};

/** The badge drawn beside `target`'s row, if any. */
const badgeOf = (target: HTMLElement): string | undefined =>
  target
    .closest('[data-slot="sidebar-menu-item"]')
    ?.querySelector('[data-slot="tree-row-mark"]')
    ?.textContent?.trim();

/** What the read toast drawn now explains, if one is drawn. */
const toastExplanation = (): string | undefined =>
  document
    .querySelector(
      '[data-sonner-toast][data-type="error"]:not([data-removed="true"]) [data-description]',
    )
    ?.textContent?.trim();

describe('the Files tree over files.decorations/v1', () => {
  test("draws a made-up provider's marks on their rows, asked for the tree's scope", async () => {
    const { projectId, asked } = await setup([
      {
        bundleId: 'made-up',
        answer: answer([
          { path: paymentForm, mark: fileMark('Reviewed', 'R') },
          { path: 'apps/web/src', mark: directoryMark('2 reviewed files', 2) },
        ]),
      },
    ]);

    assert.equal(badgeOf(row('payment-form.tsx, Reviewed')), 'R');
    assert.equal(badgeOf(row('src, 2 reviewed files')), '2');
    const scopes = asked.get('made-up') ?? [];
    assert.ok(scopes.length > 0, 'The provider was never asked.');
    for (const scope of scopes) assert.deepEqual(scope, { projectId, cwd });
  });

  // git's own changes read is not a provider: the tree names no git.* contract.
  test('decorates no row when no provider serves the contract, though git.changes/v1 is served', async () => {
    await setup([], {
      'git.changes/v1': {
        observe: (
          _scope: TreeScope,
          listener: (state: {
            readonly decorations: ReadonlyMap<string, FileMark>;
            readonly fetching: boolean;
          }) => void,
        ) => {
          listener({
            decorations: new Map([[paymentForm, fileMark('Modified', 'M')]]),
            fetching: false,
          });
          return { dispose: () => undefined };
        },
      },
    });

    assert.ok(row('payment-form.tsx'));
    assert.ok(row('src'));
    assert.equal(
      document.querySelectorAll('[data-slot="tree-row-mark"]').length,
      0,
    );
  });

  test('draws the marks of two providers that mark different paths', async () => {
    await setup([
      {
        bundleId: 'reviews',
        answer: answer([
          { path: paymentForm, mark: fileMark('Reviewed', 'R') },
        ]),
      },
      {
        bundleId: 'owners',
        answer: answer([
          { path: shippingStep, mark: fileMark('Owned by checkout', 'O') },
        ]),
      },
    ]);

    assert.equal(badgeOf(row('payment-form.tsx, Reviewed')), 'R');
    assert.equal(badgeOf(row('shipping-step.tsx, Owned by checkout')), 'O');
  });

  test('draws the mark of the provider with the smaller bundle id for a path both mark', async () => {
    await setup([
      {
        bundleId: 'zeta',
        answer: answer([
          { path: paymentForm, mark: fileMark('Marked by zeta', 'Z') },
        ]),
      },
      {
        bundleId: 'alpha',
        answer: answer([
          { path: paymentForm, mark: fileMark('Marked by alpha', 'A') },
        ]),
      },
    ]);

    assert.equal(badgeOf(row('payment-form.tsx, Marked by alpha')), 'A');
    assert.equal(
      rowLabels().some((label) => label.includes('Marked by zeta')),
      false,
    );
  });

  test("shows a provider's error in the read toast and still draws the other's marks", async () => {
    await setup([
      {
        bundleId: 'reviews',
        answer: answer([], { error: 'The review service is unavailable.' }),
      },
      {
        bundleId: 'owners',
        answer: answer([
          { path: shippingStep, mark: fileMark('Owned by checkout', 'O') },
        ]),
      },
    ]);

    assert.equal(toastExplanation(), 'The review service is unavailable.');
    assert.equal(badgeOf(row('shipping-step.tsx, Owned by checkout')), 'O');
  });
});
