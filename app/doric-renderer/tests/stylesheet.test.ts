/**
 * The window's styles are two sheets now: desktop-ui's `theme.css`, which the
 * shell loads first, and this renderer's `styles.css`. Together they have to
 * cascade as the one stylesheet the renderer compiled before: the theme owns
 * the preflight, the faces and the tokens once, and the renderer's sheet adds
 * its own rules after it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';

import tailwind from '@tailwindcss/postcss';
import postcss, { type Root } from 'postcss';

const renderer = join(__dirname, '../..');
const repository = join(renderer, '../..');

const compile = async (file: string): Promise<Root> => {
  const result = await postcss([tailwind({ base: repository })]).process(
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

describe('window stylesheets', () => {
  let theme: Root;
  let legacy: Root;

  before(async () => {
    theme = await compile(
      join(repository, 'packages/desktop-ui/src/styles/theme.css'),
    );
    legacy = await compile(join(renderer, 'src/styles.css'));
  });

  test('every utility the theme emits comes again, in the same order, in the renderer sheet', () => {
    // A class both sheets emit wins by its position in the later sheet, so the
    // renderer sheet must hold the theme's utilities in the theme's order for
    // the cascade to match one compiled stylesheet.
    const themed = utilitySelectors(theme);
    const own = utilitySelectors(legacy);
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

  test('the renderer sheet uses the theme utilities the app is written with', () => {
    const own = new Set(utilitySelectors(legacy));

    for (const selector of [
      '.bg-background',
      '.text-muted-foreground',
      '.font-conversation',
    ]) {
      assert.ok(own.has(selector), selector);
    }
  });

  test('faces, tokens and the preflight are defined once, by the theme', () => {
    let faces = 0;
    legacy.walkAtRules('font-face', () => {
      faces += 1;
    });
    let tokens = 0;
    legacy.walkDecls(/^--(background|foreground|radius|font-sans)$/, () => {
      tokens += 1;
    });

    assert.equal(faces, 0);
    assert.equal(tokens, 0);
    assert.equal(unlayered(legacy, 'html, :host'), undefined);

    let themeFaces = 0;
    theme.walkAtRules('font-face', () => {
      themeFaces += 1;
    });
    assert.equal(themeFaces, 12);
  });

  test("the renderer's unlayered rules stay outside every layer", () => {
    assert.equal(
      unlayered(legacy, '.chrome-bar')
        ?.nodes.find((node) => node.type === 'decl' && node.prop === 'height')
        ?.toString(),
      'height: 2.25rem',
    );
    assert.ok(
      unlayered(
        legacy,
        '.monaco-editor .monaco-scrollable-element > .scrollbar > .slider',
      ),
    );
  });
});
