/**
 * The Button's variants are visual contracts the app reads: `solid` is the
 * composer's white control, so its fill stays white with a dark icon in every
 * theme, and a disabled control stays faded and takes no pointer events.
 *
 * The import resolves through the package's export map, so this exercises the
 * artifact the windows load, not only the source it was built from.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Button, buttonVariants } from 'desktop/ui/button';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const classes = (variant: 'default' | 'ghost' | 'solid'): readonly string[] =>
  buttonVariants({ variant }).split(' ');

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
});
