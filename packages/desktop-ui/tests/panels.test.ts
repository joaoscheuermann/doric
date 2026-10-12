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
} from 'desktop-ui/panels';
import { SidebarProvider } from 'desktop-ui/sidebar';
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
