/**
 * The pin's state and size are the design system's own variants: the colour
 * alone says where a thread stands, and the three sizes step the teardrop and
 * its number together. The import resolves through the package's export map, so
 * this exercises the artifact the windows load, not only the source.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CommentPin, commentPinVariants } from 'desktop/ui/comment-pin';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const classes = (size: 'sm' | 'md' | 'lg'): readonly string[] =>
  commentPinVariants({ size }).split(' ');

describe('CommentPin', () => {
  test('the three sizes step the teardrop and its number together', () => {
    assert.ok(classes('sm').includes('size-5'));
    assert.ok(classes('sm').includes('text-[10px]'));
    assert.ok(classes('md').includes('size-6'));
    assert.ok(classes('md').includes('text-[11px]'));
    assert.ok(classes('lg').includes('size-7'));
    assert.ok(classes('lg').includes('text-[12px]'));
  });

  test('the colour alone says the state, and the draft is dashed', () => {
    assert.ok(
      commentPinVariants({ state: 'open' }).split(' ').includes('bg-primary'),
    );
    assert.ok(
      commentPinVariants({ state: 'done' })
        .split(' ')
        .includes('bg-[var(--paper-green)]'),
    );
    const draft = commentPinVariants({ state: 'draft' }).split(' ');
    assert.ok(draft.includes('border-dashed'));
    // The state is the fill: no badge rides on the pin.
    assert.ok(!draft.some((name) => name.includes('badge')));
  });

  test('renders the state and size it was given', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentPin, { state: 'await', size: 'lg' }, '2'),
    );
    assert.match(markup, /^<button /);
    assert.match(markup, /data-state="await"/);
    assert.match(markup, /data-size="lg"/);
    assert.match(markup, /class="[^"]*size-7[^"]*"/);
    assert.match(markup, />2<\/button>$/);
  });

  test('defaults to the medium pin', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentPin, { state: 'open' }, '1'),
    );
    assert.match(markup, /data-size="md"/);
    assert.match(markup, /class="[^"]*size-6[^"]*"/);
  });
});
