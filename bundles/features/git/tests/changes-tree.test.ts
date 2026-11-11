/**
 * The Changes tree's repository row is the tree row Files draws: one lead slot
 * that shows the branch icon alone, open or closed, with no hover or focus
 * swap and no chevron (sidebar alignment U11, T-1.8). Hover is CSS, so the
 * classes are the assertion; `aria-expanded` says whether the row is open.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SidebarProvider } from 'desktop/ui/sidebar';
import { Window } from 'happy-dom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChangesTree } from '../src/client/changes/changes-tree.js';
import { changeDirectoryKey } from '../src/client/reads/change-tree.js';

const repository = {
  path: 'project',
  added: 3,
  removed: 1,
  changes: [{ path: 'src/a.ts', status: 'modified' as const }],
};

const label = 'project, 3 lines added, 1 lines removed';

const render = (open: boolean, discards = false): string =>
  renderToStaticMarkup(
    createElement(
      SidebarProvider,
      null,
      createElement(ChangesTree, {
        repository,
        collapsed: new Set(
          open ? [] : [changeDirectoryKey(repository.path, repository.path)],
        ),
        onToggle: () => undefined,
        onOpen: () => undefined,
        ...(discards ? { onDiscard: () => undefined } : {}),
      }),
    ),
  );

/** The opening tag's class list and the inner markup of the repository row. */
const row = (markup: string): { classes: string[]; inner: string } => {
  const found = new RegExp(
    `<div(?=[^>]*role="treeitem")(?=[^>]*aria-label="${label}")[^>]*class="([^"]*)"[^>]*>([\\s\\S]*?)</div>`,
    'u',
  ).exec(markup);
  assert.ok(found, 'no repository row');
  return { classes: (found[1] ?? '').split(/\s+/u), inner: found[2] ?? '' };
};

/** The opening tag of the repository row, for its attributes. */
const rowTag = (markup: string): string => {
  const found = new RegExp(
    `<div(?=[^>]*role="treeitem")(?=[^>]*aria-label="${label}")[^>]*>`,
    'u',
  ).exec(markup);
  assert.ok(found, 'no repository row');
  return found[0];
};

/** The class list of the `lucide-<icon>` svg in `html`, if one is there. */
const iconClasses = (
  html: string,
  icon: string,
): readonly string[] | undefined => {
  const found = new RegExp(
    `<svg[^>]*class="([^"]*\\blucide-${icon}\\b[^"]*)"`,
    'u',
  ).exec(html);
  return found?.[1]?.split(/\s+/u);
};

/** The row's lead slot: the first element in the row, a span, and its content. */
const leadSlot = (inner: string): string => {
  const found = /^<span[^>]*>([\s\S]*?)<\/span>/u.exec(inner);
  assert.ok(found, `the row does not open with a lead slot: ${inner}`);
  return found[1] ?? '';
};

const iconCount = (html: string): number => (html.match(/<svg/gu) ?? []).length;

describe('the repository row of the Changes tree', () => {
  /** The classes that show or hide an icon only on hover or focus. */
  const hoverClasses = (html: string): string[] =>
    [...html.matchAll(/class="([^"]*)"/gu)].flatMap((found) =>
      (found[1] ?? '')
        .split(/\s+/u)
        .filter((name) =>
          /^(hidden|group-(hover|focus-within)\/tree-row:\S+)$/u.test(name),
        ),
    );

  for (const [state, open, expanded] of [
    ['a closed', false, 'false'],
    ['an open', true, 'true'],
  ] as const) {
    test(`T-1.8: ${state} repository shows only its branch icon, with no hover swap`, () => {
      const markup = render(open);
      const { inner } = row(markup);
      const slot = leadSlot(inner);
      assert.equal(iconCount(slot), 1, 'the slot holds the branch icon alone');
      assert.equal(iconCount(inner), 1, 'no icon sits outside the lead slot');
      assert.ok(
        iconClasses(slot, 'git-branch'),
        'the repository shows its branch icon',
      );
      assert.deepEqual(
        hoverClasses(slot),
        [],
        'the slot swaps on hover or focus',
      );
      assert.equal(iconClasses(markup, 'chevron-right'), undefined);
      assert.match(
        rowTag(markup),
        new RegExp(`aria-expanded="${expanded}"`, 'u'),
      );
    });
  }

  test('has the tree row shape: 4 px radius and a name in the normal weight', () => {
    const markup = render(false);
    const { classes, inner } = row(markup);
    assert.ok(classes.includes('rounded-[4px]'));
    assert.ok(classes.includes('gap-1.5'));
    assert.ok(!classes.includes('rounded-none'));

    const name = /<span[^>]*class="([^"]*)"[^>]*>project<\/span>/u.exec(
      inner,
    )?.[1];
    assert.ok(name, 'the row names the repository');
    assert.ok(name.split(/\s+/u).includes('font-normal'));
    assert.ok(!name.split(/\s+/u).includes('font-light'));
  });
});

/** Parses static markup into a document whose elements can be walked. */
const parse = (markup: string): Document => {
  const document = new Window().document;
  document.body.innerHTML = markup;
  return document as unknown as Document;
};

/** The repository row's `treeitem`. */
const repositoryItem = (document: Document): Element => {
  const found = Array.from(document.querySelectorAll('[role="treeitem"]')).find(
    (item) => item.getAttribute('aria-label') === label,
  );
  assert.ok(found, 'no repository row');
  return found;
};

const classesOf = (element: Element): readonly string[] =>
  Array.from(element.classList);

describe('the repository row in a column that scrolls sideways', () => {
  for (const [state, discards] of [
    ['without', false],
    ['with', true],
  ] as const) {
    test(`T-4.4: ${state} a context menu, it is a flex row ending in a pinned mark with the line totals`, () => {
      const document = parse(render(true, discards));
      const button = repositoryItem(document);
      const wrapper = button.parentElement;
      assert.ok(wrapper, 'the repository row has no wrapper');
      const outer = classesOf(wrapper);
      assert.ok(outer.includes('group/tree-row'), outer.join(' '));
      assert.ok(outer.includes('flex'), outer.join(' '));
      assert.ok(!outer.includes('overflow-hidden'), outer.join(' '));

      const inner = classesOf(button);
      for (const token of ['peer/menu-button', 'min-w-0', 'flex-1', 'pr-1.5']) {
        assert.ok(inner.includes(token), `lacks ${token}: ${inner.join(' ')}`);
      }
      for (const token of ['w-full', 'pr-8']) {
        assert.ok(!inner.includes(token), `has ${token}: ${inner.join(' ')}`);
      }

      const mark = wrapper.lastElementChild;
      assert.ok(mark, 'the row is empty');
      assert.equal(
        mark.getAttribute('data-slot'),
        'tree-row-mark',
        'the row does not end in its mark',
      );
      assert.ok(
        button.compareDocumentPosition(mark) & 4,
        'the mark does not follow the button',
      );
      const classes = classesOf(mark);
      for (const token of [
        'sticky',
        'right-1',
        'shrink-0',
        'peer-hover/menu-button:text-sidebar-accent-foreground',
        'peer-data-active/menu-button:text-sidebar-accent-foreground',
      ]) {
        assert.ok(
          classes.includes(token),
          `mark lacks ${token}: ${classes.join(' ')}`,
        );
      }
      for (const token of ['absolute', 'w-0']) {
        assert.ok(!classes.includes(token), classes.join(' '));
      }
      assert.ok(
        !classes.some((token) => /^top-/u.test(token)),
        classes.join(' '),
      );

      const badge = Array.from(mark.querySelectorAll('div')).find((div) => {
        const list = classesOf(div);
        return list.includes('h-5') && list.includes('min-w-5');
      });
      assert.ok(badge, 'the mark holds no h-5 min-w-5 badge');
      const totals = badge.textContent ?? '';
      assert.ok(totals.includes('+3'), totals);
      assert.ok(totals.includes('−1'), totals);
    });
  }

  test("T-4.4: the open repository's changes do not clip the marks", () => {
    const document = parse(render(true));
    const group = repositoryItem(document)
      .closest('[role="presentation"]')
      ?.querySelector('[role="group"]');
    assert.ok(group, 'the open repository draws no group');
    assert.ok(
      classesOf(group).includes('overflow-visible'),
      classesOf(group).join(' '),
    );
  });
});

describe('the repository row states (phase 5)', () => {
  const unselectedFill = [
    'rounded-[4px]',
    'hover:bg-[color-mix(in_oklch,var(--sidebar-accent)_50%,var(--sidebar))]',
    'active:bg-[color-mix(in_oklch,var(--sidebar-accent)_80%,var(--sidebar))]',
  ];
  const treeitemRing = [
    'has-[[role=treeitem]:focus-visible]:ring-2',
    'has-[[role=treeitem]:focus-visible]:ring-inset',
    'has-[[role=treeitem]:focus-visible]:ring-sidebar-ring',
  ];
  const noFillButton = [
    'bg-transparent',
    'hover:bg-transparent',
    'active:bg-transparent',
    'data-active:bg-transparent',
    'focus-visible:ring-0',
  ];
  const notOnNoFillButton = [
    'hover:bg-sidebar-accent',
    'active:bg-sidebar-accent',
    'data-active:bg-sidebar-accent',
    'focus-visible:ring-2',
    'hover:text-sidebar-foreground',
  ];
  const assertTokens = (
    classes: readonly string[],
    has: readonly string[],
    lacks: readonly string[],
    what: string,
  ): void => {
    for (const token of has) {
      assert.ok(
        classes.includes(token),
        `${what} lacks ${token}: ${classes.join(' ')}`,
      );
    }
    for (const token of lacks) {
      assert.ok(
        !classes.includes(token),
        `${what} has ${token}: ${classes.join(' ')}`,
      );
    }
  };

  test('T-5.4: the wrapper has the unselected fill and the treeitem ring; the button is the no-fill button', () => {
    const document = parse(render(true, true));
    const button = repositoryItem(document);
    const wrapper = button.parentElement;
    assert.ok(wrapper, 'the repository row has no wrapper');
    assertTokens(
      classesOf(wrapper),
      [...unselectedFill, ...treeitemRing],
      ['bg-sidebar-accent'],
      'wrapper',
    );
    assertTokens(classesOf(button), noFillButton, notOnNoFillButton, 'button');
  });

  test('T-5.4: the mark backing is opaque and follows the row fill', () => {
    const document = parse(render(true));
    const mark = repositoryItem(document).parentElement?.lastElementChild;
    assert.ok(mark, 'the row has no mark');
    const backing = Array.from(mark.querySelectorAll('div')).find((div) => {
      const list = classesOf(div);
      return list.includes('h-5') && list.includes('min-w-5');
    });
    assert.ok(backing, 'the mark holds no h-5 min-w-5 backing');
    assertTokens(
      classesOf(backing),
      [
        'bg-sidebar',
        'group-hover/tree-row:bg-[color-mix(in_oklch,var(--sidebar-accent)_50%,var(--sidebar))]',
        'group-active/tree-row:bg-[color-mix(in_oklch,var(--sidebar-accent)_80%,var(--sidebar))]',
      ],
      ['bg-sidebar/90'],
      'backing',
    );
  });
});
