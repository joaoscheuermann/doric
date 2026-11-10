/**
 * The Button's variants are visual contracts the app reads: `solid` is the
 * composer's white control, so its fill stays white with a dark icon in every
 * theme, and a disabled control stays faded and takes no pointer events.
 *
 * The import resolves through the package's export map, so this exercises the
 * artifact the windows load, not only the source it was built from.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compile } from '@tailwindcss/node';
import { Button, buttonVariants } from 'desktop/ui/button';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const classes = (variant: 'default' | 'ghost' | 'solid'): readonly string[] =>
  buttonVariants({ variant }).split(' ');

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** The app's theme sheet built from `candidates`, whitespace collapsed. */
const themeSheet = async (candidates: string[]): Promise<string> => {
  const file = join(packageRoot, 'src/styles/theme.css');
  const compiler = await compile(readFileSync(file, 'utf8'), {
    base: dirname(file),
    onDependency: () => undefined,
  });
  return compiler.build(candidates).replaceAll(/\s+/g, ' ');
};

describe('Button', () => {
  test('solid fills white and keeps a dark icon in every theme', () => {
    const solid = classes('solid');
    assert.ok(solid.includes('bg-white'));
    assert.ok(solid.includes('text-[#101010]'));
    // A `dark:` foreground override would paint the light theme's ink on a
    // white fill, which is the bug this variant exists to avoid.
    assert.ok(!solid.some((name) => name.startsWith('dark:text-')));
  });

  test('the other variants keep their own fills', () => {
    assert.ok(classes('default').includes('bg-primary'));
    assert.ok(classes('ghost').includes('hover:bg-muted'));
  });

  test('disabled fades the control and takes its pointer events away', () => {
    const base = classes('solid');
    assert.ok(base.includes('disabled:opacity-50'));
    assert.ok(base.includes('disabled:pointer-events-none'));

    const markup = renderToStaticMarkup(
      createElement(Button, {
        variant: 'solid',
        disabled: true,
        'aria-label': 'Send (Cmd+Enter)',
      }),
    );
    assert.match(markup, /^<button /);
    assert.match(markup, /disabled=""/);
    assert.match(markup, /class="[^"]*bg-white[^"]*"/);
  });

  test('every theme sheet defines the radius the small buttons read, whatever it was built from', async () => {
    for (const candidates of [[], ['h-7']]) {
      const css = await themeSheet(candidates);
      assert.ok(
        css.includes('--radius-md: calc(var(--radius) - 2px)'),
        `--radius-md is missing from the sheet built from [${candidates.join(', ')}]`,
      );
    }
  });

  test('the `sm` and `xs` radii cap the shared medium radius', async () => {
    const sm = await themeSheet(['rounded-[min(var(--radius-md),12px)]']);
    assert.match(sm, /border-radius: min\(var\(--radius-md\), 12px\);/);
    const xs = await themeSheet(['rounded-[min(var(--radius-md),10px)]']);
    assert.match(xs, /border-radius: min\(var\(--radius-md\), 10px\);/);
  });
});
