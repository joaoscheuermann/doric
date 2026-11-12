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
import { Window } from 'happy-dom';
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

  /** The classes that show or hide an icon only on hover or focus. */
  const hoverClasses = (html: string): string[] =>
    [...html.matchAll(/class="([^"]*)"/gu)].flatMap((found) =>
      (found[1] ?? '')
        .split(/\s+/u)
        .filter((name) =>
          /^(hidden|group-(hover|focus-within)\/tree-row:\S+)$/u.test(name),
        ),
    );

  /** The `aria-expanded` of the tree row labelled `name`, if it has one. */
  const expandedOf = (html: string, name: string): string | undefined =>
    new RegExp(
      `<div(?=[^>]*role="treeitem")(?=[^>]*aria-label="${name}")[^>]*>`,
      'u',
    )
      .exec(html)?.[0]
      .match(/aria-expanded="([^"]*)"/u)?.[1];

  test('T-1.7: a closed directory shows only its folder, with no hover swap', () => {
    const inner = row(markup, 'closed');
    const slot = leadSlot(inner);
    assert.equal(iconCount(slot), 1, 'the slot holds the folder alone');
    assert.equal(iconCount(inner), 1, 'no icon sits outside the lead slot');
    assert.ok(
      iconClasses(slot, 'folder'),
      'the closed directory shows a folder',
    );
    assert.deepEqual(
      hoverClasses(slot),
      [],
      'the slot swaps on hover or focus',
    );
    assert.equal(expandedOf(markup, 'closed'), 'false');
  });

  test('T-1.7: an open directory shows only its open folder, with no hover swap', () => {
    const inner = row(markup, 'open');
    const slot = leadSlot(inner);
    assert.equal(iconCount(slot), 1, 'the slot holds the open folder alone');
    assert.equal(iconCount(inner), 1, 'no icon sits outside the lead slot');
    assert.ok(
      iconClasses(slot, 'folder-open'),
      'the open directory shows an open folder',
    );
    assert.ok(
      !/\blucide-folder[\s"]/u.test(inner),
      'the open directory shows no closed folder',
    );
    assert.deepEqual(
      hoverClasses(slot),
      [],
      'the slot swaps on hover or focus',
    );
    assert.equal(expandedOf(markup, 'open'), 'true');
  });

  test('T-1.7: the tree draws no chevron', () => {
    assert.equal(iconClasses(markup, 'chevron-right'), undefined);
  });

  test('a file shows only its file icon', () => {
    const inner = row(markup, 'file.ts');
    const slot = leadSlot(inner);
    assert.equal(iconCount(inner), 1);
    assert.equal(iconCount(slot), 1);
    assert.ok(iconClasses(slot, 'file'), 'the file row shows a file icon');
    assert.equal(iconClasses(inner, 'chevron-right'), undefined);
  });

  test('an undecorated name is set in the normal weight', () => {
    const classes = /<span[^>]*class="([^"]*)"[^>]*>file\.ts<\/span>/u
      .exec(row(markup, 'file.ts'))?.[1]
      ?.split(/\s+/u);
    assert.ok(classes, 'the name sits in its own span');
    assert.ok(classes.includes('font-normal'), classes.join(' '));
    assert.ok(!classes.includes('font-light'), classes.join(' '));
  });
});

/** Parses static markup into a document whose elements can be walked. */
const parse = (markup: string): Document => {
  const document = new Window().document;
  document.body.innerHTML = markup;
  return document as unknown as Document;
};

/** The tree row (the `treeitem`) whose label is `name` or starts `name, `. */
const treeItem = (document: Document, name: string): Element => {
  const found = [...document.querySelectorAll('[role="treeitem"]')].find(
    (item) => {
      const label = item.getAttribute('aria-label') ?? '';
      return label === name || label.startsWith(`${name}, `);
    },
  );
  assert.ok(found, `no tree row labelled ${name}`);
  return found;
};

const classesOf = (element: Element): readonly string[] => [
  ...element.classList,
];

/** The mark a row draws beside its button, if it draws one. */
const markOf = (wrapper: Element): Element | undefined =>
  [...wrapper.children].find(
    (child) => child.getAttribute('data-slot') === 'tree-row-mark',
  );

describe('a tree row in a column that scrolls sideways', () => {
  const deleted: TreeDecoration = {
    description: 'deleted · Unstaged',
    count: 1,
    tone: 'tone-deleted',
    letter: 'D',
    struck: true,
  };
  const decorations = new Map<string, TreeDecoration>([
    [
      'src',
      { description: '2 changed files', count: 2, tone: 'tone-modified' },
    ],
    ['src/gone.ts', deleted],
  ]);
  const document = parse(render(decorations));

  test('T-4.1: every row is a flex row that does not clip, its button growing to fill it', () => {
    for (const name of ['src', 'gone.ts', 'plain.ts']) {
      const button = treeItem(document, name);
      const wrapper = button.parentElement;
      assert.ok(wrapper, `${name} has no row wrapper`);
      const outer = classesOf(wrapper);
      assert.ok(outer.includes('group/tree-row'), outer.join(' '));
      assert.ok(outer.includes('flex'), `${name}: ${outer.join(' ')}`);
      assert.ok(
        !outer.includes('overflow-hidden'),
        `${name}: ${outer.join(' ')}`,
      );

      const inner = classesOf(button);
      for (const token of ['peer/menu-button', 'min-w-0', 'flex-1', 'pr-1.5']) {
        assert.ok(
          inner.includes(token),
          `${name} lacks ${token}: ${inner.join(' ')}`,
        );
      }
      for (const token of ['w-full', 'pr-8']) {
        assert.ok(
          !inner.includes(token),
          `${name} has ${token}: ${inner.join(' ')}`,
        );
      }
    }
  });

  test('T-4.2: a decorated row ends in a mark pinned to the right edge, after its button', () => {
    for (const [name, text] of [
      ['src', '2'],
      ['gone.ts', 'D'],
    ] as const) {
      const button = treeItem(document, name);
      const wrapper = button.parentElement;
      assert.ok(wrapper, `${name} has no row wrapper`);
      const mark = markOf(wrapper);
      assert.ok(mark, `${name} draws no tree-row-mark`);
      assert.equal(
        wrapper.lastElementChild,
        mark,
        `${name}: the mark is not last`,
      );
      assert.ok(
        button.compareDocumentPosition(mark) & 4,
        `${name}: the mark does not follow the button`,
      );
      assert.equal(mark.getAttribute('aria-hidden'), 'true');

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
          `${name} mark lacks ${token}: ${classes.join(' ')}`,
        );
      }
      assert.ok(!classes.includes('absolute'), classes.join(' '));
      assert.ok(!classes.includes('w-0'), classes.join(' '));
      assert.ok(
        !classes.some((token) => /^top-/u.test(token)),
        classes.join(' '),
      );

      const badge = [...mark.querySelectorAll('div')].find((div) => {
        const list = classesOf(div);
        return list.includes('h-5') && list.includes('min-w-5');
      });
      assert.ok(badge, `${name}: the mark holds no h-5 min-w-5 badge`);
      assert.equal(badge.textContent?.trim(), text);
    }
  });

  test('T-4.2: an undecorated row draws no mark', () => {
    const wrapper = treeItem(document, 'plain.ts').parentElement;
    assert.ok(wrapper);
    assert.equal(markOf(wrapper), undefined);
    assert.equal(
      parse(render(undefined)).querySelector('[data-slot="tree-row-mark"]'),
      null,
      'a tree with no decorations draws marks',
    );
  });

  test('T-4.2: the mark stays the last child when the row has a context menu', () => {
    const markup = renderToStaticMarkup(
      createElement(
        SidebarProvider,
        null,
        createElement(FileTree, {
          actions,
          depth: 0,
          entries: [{ name: 'gone.ts', path: 'gone.ts', type: 'file' }],
          expanded: new Set<string>(),
          decorations: new Map([['gone.ts', deleted]]),
          rowMenu: () => 'Discard changes',
        }),
      ),
    );
    const button = treeItem(parse(markup), 'gone.ts');
    const wrapper = button.parentElement;
    assert.ok(wrapper);
    const mark = markOf(wrapper);
    assert.ok(mark, 'the row draws no tree-row-mark');
    assert.equal(wrapper.lastElementChild, mark);
    assert.ok(button.compareDocumentPosition(mark) & 4);
  });

  test("T-4.2: an open directory's children do not clip the marks", () => {
    // The tree draws its lines flat (one row per line, windowed), so a nested
    // row's mark has no group of its own between it and the tree: nothing
    // above any mark may clip it.
    const marks = document.querySelectorAll('[data-slot="tree-row-mark"]');
    assert.ok(marks.length > 1, 'the tree draws fewer than two marks');
    for (const mark of Array.from(marks)) {
      for (
        let node = mark.parentElement;
        node !== null && node !== document.body;
        node = node.parentElement
      ) {
        assert.ok(
          !classesOf(node).includes('overflow-hidden'),
          classesOf(node).join(' '),
        );
      }
    }
  });
});

/** The class sets of the spec's §11 (docs/designs/sidebar-alignment.md). */
const UNSELECTED_FILL = [
  'rounded-[4px]',
  'hover:bg-[var(--paper-ghost-hover)]',
  'active:bg-[var(--paper-ghost-pressed)]',
] as const;
const SELECTED_FILL = ['rounded-[4px]', 'bg-sidebar-accent'] as const;
const TREEITEM_RING = [
  'has-[[role=treeitem]:focus-visible]:outline-2',
  'has-[[role=treeitem]:focus-visible]:-outline-offset-2',
  'has-[[role=treeitem]:focus-visible]:outline-[var(--sidebar-ring)]',
] as const;
const NO_FILL_BUTTON = [
  'bg-transparent',
  'hover:bg-transparent',
  'active:bg-transparent',
  'data-active:bg-transparent',
  'focus-visible:ring-0',
] as const;
const NOT_ON_NO_FILL_BUTTON = [
  'hover:bg-sidebar-accent',
  'active:bg-sidebar-accent',
  'data-active:bg-sidebar-accent',
  'focus-visible:ring-2',
  'hover:text-sidebar-foreground',
] as const;
const MARK_HOVER =
  'group-hover/tree-row:bg-[linear-gradient(var(--paper-ghost-hover),var(--paper-ghost-hover))]';
const MARK_ACTIVE =
  'group-active/tree-row:bg-[linear-gradient(var(--paper-ghost-pressed),var(--paper-ghost-pressed))]';

const assertHas = (
  classes: readonly string[],
  tokens: readonly string[],
  what: string,
): void => {
  for (const token of tokens) {
    assert.ok(
      classes.includes(token),
      `${what} lacks ${token}: ${classes.join(' ')}`,
    );
  }
};

const assertLacks = (
  classes: readonly string[],
  tokens: readonly string[],
  what: string,
): void => {
  for (const token of tokens) {
    assert.ok(
      !classes.includes(token),
      `${what} has ${token}: ${classes.join(' ')}`,
    );
  }
};

describe('tree row states (phase 5)', () => {
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
    [
      'src/plain.ts',
      {
        description: 'modified · Unstaged',
        count: 1,
        tone: 'tone-modified',
        letter: 'M',
      },
    ],
  ]);
  const document = parse(
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
          expanded: new Set(['src']),
          decorations,
          selectedPath: 'src/gone.ts',
        }),
      ),
    ),
  );
  const unselected = ['src', 'plain.ts'] as const;
  const wrapperOf = (name: string): Element => {
    const wrapper = treeItem(document, name).parentElement;
    assert.ok(wrapper, `${name} has no row wrapper`);
    assert.ok(
      classesOf(wrapper).includes('group/tree-row'),
      `${name}: not a tree-row wrapper`,
    );
    return wrapper;
  };
  const backingOf = (name: string): Element => {
    const mark = markOf(wrapperOf(name));
    assert.ok(mark, `${name} draws no tree-row-mark`);
    const backing = [...mark.querySelectorAll('div')].find((div) => {
      const list = classesOf(div);
      return list.includes('h-5') && list.includes('min-w-5');
    });
    assert.ok(backing, `${name}: the mark holds no h-5 min-w-5 backing`);
    return backing;
  };

  test('T-5.1: the selected row wrapper has the selected fill and the treeitem ring, and no hover or active mix', () => {
    const classes = classesOf(wrapperOf('gone.ts'));
    assertHas(classes, [...SELECTED_FILL, ...TREEITEM_RING], 'gone.ts wrapper');
    assert.ok(
      !classes.some((token) => /^(hover|active):bg-\[/u.test(token)),
      classes.join(' '),
    );
  });

  test('T-5.1: every other row wrapper has the unselected fill and the treeitem ring, and no accent', () => {
    for (const name of unselected) {
      const classes = classesOf(wrapperOf(name));
      assertHas(
        classes,
        [...UNSELECTED_FILL, ...TREEITEM_RING],
        `${name} wrapper`,
      );
      assertLacks(classes, ['bg-sidebar-accent'], `${name} wrapper`);
    }
  });

  test('T-5.2: every treeitem is the no-fill button and keeps its shape', () => {
    const items = [...document.querySelectorAll('[role="treeitem"]')];
    assert.equal(items.length, 3);
    for (const item of items) {
      const classes = classesOf(item);
      const what = item.getAttribute('aria-label') ?? '?';
      assertHas(
        classes,
        [...NO_FILL_BUTTON, 'rounded-[4px]', 'flex-1', 'min-w-0', 'pr-1.5'],
        what,
      );
      assertLacks(classes, NOT_ON_NO_FILL_BUTTON, what);
    }
  });

  test('T-5.2: the selected treeitem keeps data-active and aria-selected', () => {
    const item = treeItem(document, 'gone.ts');
    assert.ok(item.hasAttribute('data-active'), 'gone.ts has no data-active');
    assert.equal(item.getAttribute('aria-selected'), 'true');
  });

  test('T-5.3: an unselected mark backing is opaque and follows the row fill', () => {
    for (const name of unselected) {
      const classes = classesOf(backingOf(name));
      assertLacks(classes, ['bg-sidebar/90'], `${name} backing`);
      assertHas(
        classes,
        ['bg-sidebar', MARK_HOVER, MARK_ACTIVE],
        `${name} backing`,
      );
    }
  });

  test('T-5.3: the selected mark backing takes the accent and no hover mix', () => {
    const classes = classesOf(backingOf('gone.ts'));
    assertLacks(classes, ['bg-sidebar/90'], 'gone.ts backing');
    assertHas(classes, ['bg-sidebar-accent'], 'gone.ts backing');
    assert.ok(
      !classes.some((token) => token.startsWith('group-hover/tree-row:bg-[')),
      classes.join(' '),
    );
  });
});
