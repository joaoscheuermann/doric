/**
 * The panel widgets a bundle renders with its own rows: the expansion helper
 * the tree and the Changes view share, and the file tree's decorations, which
 * the bundle that knows the marks supplies and the tree only draws.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  emptyDirectoryNotice,
  FileTree,
  type FileTreeActions,
  type TreeDecoration,
  toggleExpanded,
} from 'desktop/ui/panels';
import { SidebarProvider } from 'desktop/ui/sidebar';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('the notice an empty directory shows', () => {
  test('says that the directory is empty', () => {
    assert.equal(emptyDirectoryNotice, 'This directory is empty.');
  });
});

describe('toggling an expanded set', () => {
  test('adds a path that is absent and removes one that is present', () => {
    const expanded = toggleExpanded(new Set(['src']), 'src/domain');
    assert.deepEqual([...expanded].sort(), ['src', 'src/domain']);
    assert.deepEqual([...toggleExpanded(expanded, 'src')], ['src/domain']);
  });

  test('leaves the set it was given untouched', () => {
    const before = new Set(['src']);
    toggleExpanded(before, 'src/domain');
    assert.deepEqual([...before], ['src']);
  });
});

const actions: FileTreeActions = {
  open: () => undefined,
  toggle: () => undefined,
};

const render = (
  decorations: ReadonlyMap<string, TreeDecoration> | undefined,
  expanded: ReadonlySet<string> = new Set(['src']),
): string =>
  renderToStaticMarkup(
    createElement(
      SidebarProvider,
      null,
      createElement(FileTree, {
        actions,
        depth: 0,
        entries: [
          {
            name: 'src',
            path: 'src',
            type: 'directory',
            children: [
              { name: 'gone.ts', path: 'src/gone.ts', type: 'file' },
              { name: 'plain.ts', path: 'src/plain.ts', type: 'file' },
            ],
          },
        ],
        expanded,
        ...(decorations === undefined ? {} : { decorations }),
      }),
    ),
  );

describe('decorated rows', () => {
  const decorations = new Map<string, TreeDecoration>([
    [
      'src',
      { description: '2 changed files', count: 2, tone: 'tone-modified' },
    ],
    [
      'src/gone.ts',
      {
        description: 'deleted · Unstaged',
        count: 1,
        tone: 'tone-deleted',
        letter: 'D',
        struck: true,
      },
    ],
  ]);

  test('draws a directory badge with its count and a file badge with its letter', () => {
    const markup = render(decorations);
    assert.match(markup, />2</u);
    assert.match(markup, />D</u);
  });

  test('states the description of a decorated row beside its name', () => {
    const markup = render(decorations);
    assert.match(markup, /aria-label="gone\.ts, deleted · Unstaged"/u);
    assert.match(markup, /aria-label="src, 2 changed files"/u);
  });

  test('strikes through a struck file and leaves an undecorated row plain', () => {
    const markup = render(decorations);
    assert.match(markup, /line-through/u);
    assert.match(markup, /aria-label="plain\.ts"/u);
  });

  test('draws no decoration at all without a map', () => {
    const markup = render(undefined);
    assert.doesNotMatch(markup, /line-through/u);
    assert.doesNotMatch(markup, /tone-/u);
    assert.match(markup, /aria-label="gone\.ts"/u);
  });
});

/** The opening tag and inner markup of the tree row labelled `name`. */
const row = (markup: string, name: string): string => {
  const pattern = new RegExp(
    `<div(?=[^>]*role="treeitem")(?=[^>]*aria-label="${name.replace(/\./gu, '\\.')}")[^>]*>([\\s\\S]*?)</div>`,
    'u',
  );
  const found = pattern.exec(markup);
  assert.ok(found, `no tree row labelled ${name}`);
  return found[1] ?? '';
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

describe('the lead slot of a tree row', () => {
  const tree = (expanded: ReadonlySet<string>): string =>
    renderToStaticMarkup(
      createElement(
        SidebarProvider,
        null,
        createElement(FileTree, {
          actions,
          depth: 0,
          entries: [
            {
              name: 'closed',
              path: 'closed',
              type: 'directory',
              children: [{ name: 'a.ts', path: 'closed/a.ts', type: 'file' }],
            },
            {
              name: 'open',
              path: 'open',
              type: 'directory',
              children: [{ name: 'b.ts', path: 'open/b.ts', type: 'file' }],
            },
            { name: 'file.ts', path: 'file.ts', type: 'file' },
          ],
          expanded,
        }),
      ),
    );
  const markup = tree(new Set(['open']));

  test('a closed directory swaps its folder for a chevron on hover or focus, in one slot', () => {
    const inner = row(markup, 'closed');
    const slot = leadSlot(inner);
    assert.equal(
      iconCount(slot),
      2,
      'the slot holds the folder and the chevron',
    );
    assert.equal(iconCount(inner), 2, 'no icon sits outside the lead slot');

    const folder = iconClasses(slot, 'folder');
    assert.ok(folder, 'the closed directory shows a folder');
    assert.ok(folder.includes('group-hover/tree-row:hidden'));
    assert.ok(folder.includes('group-focus-within/tree-row:hidden'));

    const chevron = iconClasses(slot, 'chevron-right');
    assert.ok(chevron, 'the closed directory carries a chevron');
    assert.ok(chevron.includes('hidden'));
    assert.ok(chevron.includes('group-hover/tree-row:block'));
    assert.ok(chevron.includes('group-focus-within/tree-row:block'));
    assert.ok(!chevron.includes('rotate-90'));
  });

  test('an open directory shows only a turned chevron', () => {
    const inner = row(markup, 'open');
    const slot = leadSlot(inner);
    assert.equal(iconCount(inner), 1);
    assert.equal(iconCount(slot), 1);
    assert.equal(iconClasses(inner, 'folder'), undefined);
    const chevron = iconClasses(slot, 'chevron-right');
    assert.ok(chevron, 'the open directory shows a chevron');
    assert.ok(chevron.includes('rotate-90'));
  });

  test('a file shows only its file icon', () => {
    const inner = row(markup, 'file.ts');
    const slot = leadSlot(inner);
    assert.equal(iconCount(inner), 1);
    assert.equal(iconCount(slot), 1);
    assert.ok(iconClasses(slot, 'file'), 'the file row shows a file icon');
    assert.equal(iconClasses(inner, 'chevron-right'), undefined);
  });
});
