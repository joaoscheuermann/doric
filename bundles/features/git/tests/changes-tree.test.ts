/**
 * The Changes tree's repository row is the tree row Files draws (S25): one lead
 * slot that shows the branch icon at rest and the chevron, turned down when the
 * repository is open, only while the row is hovered or focused. The swap is
 * CSS, so the classes are the assertion (T-3.5, as T-1.7 for `FileTree`).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SidebarProvider } from 'desktop/ui/sidebar';
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

const render = (open: boolean): string =>
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
  test('a closed repository swaps its branch icon for a chevron on hover or focus, in one slot', () => {
    const markup = render(false);
    const { inner } = row(markup);
    const slot = leadSlot(inner);
    assert.equal(iconCount(slot), 2, 'the slot holds the branch and chevron');
    assert.equal(iconCount(inner), 2, 'no icon sits outside the lead slot');

    const branch = iconClasses(slot, 'git-branch');
    assert.ok(branch, 'the repository shows its branch icon');
    assert.ok(branch.includes('group-hover/tree-row:hidden'));
    assert.ok(branch.includes('group-focus-within/tree-row:hidden'));

    const chevron = iconClasses(slot, 'chevron-right');
    assert.ok(chevron, 'the repository carries a chevron');
    assert.ok(chevron.includes('hidden'));
    assert.ok(chevron.includes('group-hover/tree-row:block'));
    assert.ok(chevron.includes('group-focus-within/tree-row:block'));
    assert.ok(!chevron.includes('rotate-90'));

    assert.match(rowTag(markup), /aria-expanded="false"/u);
  });

  test('an open repository turns its chevron down', () => {
    const markup = render(true);
    const { inner } = row(markup);
    const slot = leadSlot(inner);
    assert.ok(iconClasses(slot, 'git-branch'), 'the branch icon stays at rest');
    const chevron = iconClasses(slot, 'chevron-right');
    assert.ok(chevron, 'the open repository carries a chevron');
    assert.ok(chevron.includes('group-hover/tree-row:block'));
    assert.ok(chevron.includes('rotate-90'));

    assert.match(rowTag(markup), /aria-expanded="true"/u);
  });

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
