/**
 * The window's styles after the stage-9 cut-over: desktop/ui's `theme.css`
 * first, the shell's `styles.css` next, then each UI bundle's own sheet.
 * Together they have to cascade as the one stylesheet the renderer compiled
 * before: the theme owns the preflight, the faces and the tokens once, the
 * shell holds the window-wide rules and the whole sorted utility set, and the
 * conversation and editor-surface rules come from the bundles that draw them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';

import tailwind from '@tailwindcss/postcss';
import postcss, { type Root } from 'postcss';

const renderer = join(__dirname, '../..');
const repository = join(renderer, '../..');

/**
 * Compiles one sheet. The shell's is built from the repository root (webpack's
 * working directory); the theme and a bundle's sheet are built from their own
 * folder, as the platform and bundle builds do.
 */
const compile = async (
  file: string,
  base: string = repository,
): Promise<Root> => {
  const result = await postcss([tailwind({ base })]).process(
    readFileSync(file, 'utf8'),
    { from: file },
  );
  return postcss.parse(result.css);
};

const utilitySelectors = (sheet: Root): string[] => {
  const selectors: string[] = [];
  sheet.walkAtRules('layer', (layer) => {
    if (layer.params !== 'utilities') return;
    layer.each((node) => {
      if (node.type === 'rule') selectors.push(node.selector);
    });
  });
  return selectors;
};

const unlayered = (sheet: Root, selector: string) =>
  sheet.nodes.find(
    (node) => node.type === 'rule' && node.selector === selector,
  ) as postcss.Rule | undefined;

/** Every rule selector in the sheet, inside a layer or not. */
const allSelectors = (sheet: Root): Set<string> => {
  const selectors = new Set<string>();
  sheet.walkRules((rule) => {
    selectors.add(rule.selector.replace(/\s+/g, ' '));
  });
  return selectors;
};

const monacoSlider =
  '.monaco-editor .monaco-scrollable-element > .scrollbar > .slider';
const xtermSlider =
  "[data-slot='terminal-view'] .xterm .xterm-scrollable-element > .scrollbar.vertical > .slider";

describe('window stylesheets', () => {
  let theme: Root;
  let shell: Root;
  let chat: Root;
  let layout: Root;

  before(async () => {
    const themeSheet = join(
      repository,
      'packages/desktop/src/styles/theme.css',
    );
    theme = await compile(themeSheet, dirname(themeSheet));
    shell = await compile(join(renderer, 'src/styles.css'));
    const chatSheet = join(
      repository,
      'bundles/desktop/chat/src/client/styles.css',
    );
    const layoutSheet = join(
      repository,
      'bundles/desktop/layout/src/client/styles.css',
    );
    chat = await compile(chatSheet, dirname(chatSheet));
    layout = await compile(layoutSheet, dirname(layoutSheet));
  });

  test('every utility the theme emits comes again, in the same order, in the shell sheet', () => {
    // A class both sheets emit wins by its position in the later sheet, so the
    // shell sheet must hold the theme's utilities in the theme's order for
    // the cascade to match one compiled stylesheet.
    const themed = utilitySelectors(theme);
    const own = utilitySelectors(shell);
    const ownSet = new Set(own);
    const themedSet = new Set(themed);

    assert.ok(themed.length > 0);
    assert.deepEqual(
      themed.filter((selector) => !ownSet.has(selector)),
      [],
    );
    assert.deepEqual(
      own.filter((selector) => themedSet.has(selector)),
      themed,
    );
  });

  test('the shell sheet emits every utility a bundle sheet emits, in the same order', () => {
    // The legacy tree that carried the bundles' classes is gone from the
    // window; the shell still emits them, in the order one compiled sheet gave.
    const own = utilitySelectors(shell);
    const chatOnly = utilitySelectors(chat);

    for (const selector of [
      '.bg-background',
      '.text-muted-foreground',
      '.font-conversation',
    ]) {
      assert.ok(own.includes(selector), selector);
    }
    assert.deepEqual(
      chatOnly.filter((selector) => !own.includes(selector)),
      [],
    );
    assert.deepEqual(
      own.filter((selector) => chatOnly.includes(selector)),
      chatOnly,
    );
  });

  test('faces, tokens and the preflight are defined once, by the theme', () => {
    let faces = 0;
    shell.walkAtRules('font-face', () => {
      faces += 1;
    });
    let tokens = 0;
    shell.walkDecls(/^--(background|foreground|radius|font-sans)$/, () => {
      tokens += 1;
    });

    assert.equal(faces, 0);
    assert.equal(tokens, 0);
    assert.equal(unlayered(shell, 'html, :host'), undefined);

    let themeFaces = 0;
    theme.walkAtRules('font-face', () => {
      themeFaces += 1;
    });
    assert.equal(themeFaces, 12);
  });

  test('the window-wide rules stay in the shell, unlayered where they were', () => {
    assert.equal(
      unlayered(shell, '.chrome-bar')
        ?.nodes.find((node) => node.type === 'decl' && node.prop === 'height')
        ?.toString(),
      'height: 2.25rem',
    );
    const footer = unlayered(
      shell,
      ":is(footer, [data-slot$='-footer']),\n:is(footer, [data-slot$='-footer']) *",
    );
    assert.equal(
      footer?.nodes
        .find((node) => node.type === 'decl' && node.prop === 'font-weight')
        ?.toString(),
      'font-weight: 400 !important',
    );
  });

  test('the conversation and editor-surface rules come from their bundles, not from the shell', () => {
    const own = allSelectors(shell);
    for (const selector of [
      '.editor-paragraph',
      '.queue-edit-heading',
      '[data-lexical-editor] [data-placeholder]',
      ".conversation-scroll [data-trail-highlight='strong']",
      monacoSlider,
      xtermSlider,
    ]) {
      assert.equal(own.has(selector), false, selector);
    }

    assert.ok(unlayered(chat, '.editor-paragraph'));
    assert.ok(unlayered(chat, '.queue-row[data-editing]'));
    assert.ok(
      allSelectors(chat).has(
        ".conversation-scroll [data-trail-highlight='strong']",
      ),
    );
    assert.ok(unlayered(layout, monacoSlider));
    assert.ok(allSelectors(layout).has(xtermSlider));
  });

  test('the layout sheet adds no utilities of its own', () => {
    // A later sheet re-emitting a subset of utilities would move those classes
    // after the ones they are sorted before in the shell sheet.
    assert.deepEqual(utilitySelectors(layout), []);
  });
});
