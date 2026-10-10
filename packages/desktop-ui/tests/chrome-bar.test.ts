/**
 * A chrome bar is the window's draggable title strip: one height for every bar,
 * and a leading inset that keeps the window's buttons clear unless turned off.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compile } from '@tailwindcss/node';
import { ChromeBar } from 'desktop-ui/chrome-bar';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** The bar's root element as markup, and its class names. */
const render = (props: Parameters<typeof ChromeBar>[0]) => {
  const markup = renderToStaticMarkup(createElement(ChromeBar, props));
  const classes = (/class="([^"]*)"/.exec(markup)?.[1] ?? '').split(' ');
  return { classes, markup };
};

describe('ChromeBar', () => {
  test('is a draggable chrome bar that keeps the safe area clear', () => {
    const { classes, markup } = render({});
    assert.match(markup, /^<div data-slot="chrome-bar"/);
    assert.ok(classes.includes('chrome-bar'));
    assert.ok(classes.includes('[app-region:drag]'));
    assert.ok(classes.includes('ps-(--doric-safe-left)'));
  });

  test('without the inset, starts at its own edge', () => {
    const { classes } = render({ inset: false });
    assert.ok(classes.includes('chrome-bar'));
    assert.ok(!classes.includes('ps-(--doric-safe-left)'));
  });

  test("renders the caller's children, attributes and classes", () => {
    const { classes, markup } = render({
      'aria-label': 'Workspace',
      children: createElement('button', { type: 'button' }, 'Open'),
      className: 'justify-between',
    });
    assert.ok(classes.includes('justify-between'));
    assert.match(markup, /aria-label="Workspace"/);
    assert.match(markup, /<button type="button">Open<\/button><\/div>$/);
  });

  test('the theme gives it the titlebar height, the drag region and the inset', async () => {
    const file = join(packageRoot, 'src/styles/theme.css');
    const compiler = await compile(readFileSync(file, 'utf8'), {
      base: dirname(file),
      onDependency: () => undefined,
    });
    const css = compiler.build(render({}).classes).replaceAll(/\s+/g, ' ');
    assert.match(
      css,
      /\.chrome-bar \{ height: var\(--doric-titlebar-height\); \}/,
    );
    assert.match(css, /app-region: drag;/);
    assert.match(css, /padding-inline-start: var\(--doric-safe-left\);/);
  });
});
