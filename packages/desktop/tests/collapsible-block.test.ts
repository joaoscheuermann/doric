/**
 * `desktop/ui/collapsible-block` (platform 1.10.0): the transcript's
 * open-and-close section and its generic rule. A block opens while its work is
 * in progress and has something to show, folds away once the work settles, and
 * after the reader chooses, their choice stands.
 *
 * The import resolves through the package's export map, so this exercises the
 * file the windows load.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  blockOpen,
  blockToggled,
  CollapsibleBlock,
  type CollapsibleBlockProps,
} from 'desktop/ui/collapsible-block';
import { Window } from 'happy-dom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('the open state of a folding block', () => {
  test('opens while its work is in progress and has something to show', () => {
    assert.equal(blockOpen(null, { active: true, hasContent: true }), true);
  });

  test('stays folded while the work is unfinished but shows nothing', () => {
    assert.equal(blockOpen(null, { active: true, hasContent: false }), false);
  });

  test('folds away once the work settles', () => {
    assert.equal(blockOpen(null, { active: false, hasContent: true }), false);
    assert.equal(blockOpen(null, { active: false, hasContent: false }), false);
  });

  test('defaultOpen keeps a settled block with something to show open', () => {
    assert.equal(
      blockOpen(null, { active: false, hasContent: true, defaultOpen: true }),
      true,
    );
    // An empty block is never open on its own.
    assert.equal(
      blockOpen(null, { active: false, hasContent: false, defaultOpen: true }),
      false,
    );
  });

  test("follows the reader's choice over the work", () => {
    assert.equal(blockOpen(true, { active: false, hasContent: false }), true);
    assert.equal(blockOpen(false, { active: true, hasContent: true }), false);
  });
});

describe('the reader toggling a block', () => {
  test('takes the opposite of what the block shows when they have not chosen', () => {
    // The block was open on its own, so closing it is the reader's first word.
    assert.equal(blockToggled(null, { active: true, hasContent: true }), false);
    assert.equal(blockToggled(null, { active: false, hasContent: true }), true);
    assert.equal(
      blockToggled(null, {
        active: false,
        hasContent: true,
        defaultOpen: true,
      }),
      false,
    );
  });

  test('takes the opposite of their own choice afterwards', () => {
    assert.equal(
      blockToggled(true, { active: false, hasContent: true }),
      false,
    );
    assert.equal(
      blockToggled(false, { active: false, hasContent: true }),
      true,
    );
  });

  test('keeps their choice when the work changes under it', () => {
    // They closed a block that was open while it worked; the work going on
    // must not reopen it.
    const closed = blockToggled(null, { active: true, hasContent: true });
    assert.equal(blockOpen(closed, { active: true, hasContent: true }), false);
    // And the other way: a block they opened stays open once the work settles.
    const opened = blockToggled(null, { active: true, hasContent: false });
    assert.equal(blockOpen(opened, { active: false, hasContent: false }), true);
  });
});

/** The block rendered alone, parsed into a document; the document's body. */
const render = (
  props: Omit<CollapsibleBlockProps, 'onChosenChange' | 'children'>,
): HTMLElement => {
  const document = new Window().document;
  document.body.innerHTML = renderToStaticMarkup(
    createElement(
      CollapsibleBlock,
      { ...props, onChosenChange: () => undefined } as CollapsibleBlockProps,
      createElement('p', { 'data-probe': 'detail' }, 'the detail'),
    ),
  );
  return document.body as unknown as HTMLElement;
};

describe('CollapsibleBlock', () => {
  test('a closed block shows its label and not its detail', () => {
    const body = render({
      label: 'Ran a command',
      openness: { active: false, hasContent: true },
      chosen: null,
    });
    assert.ok(body.textContent?.includes('Ran a command'), body.innerHTML);
    assert.equal(body.querySelector('[data-probe="detail"]'), null);
  });

  test('an open block shows its label and its detail', () => {
    for (const [chosen, openness] of [
      [null, { active: true, hasContent: true }],
      [true, { active: false, hasContent: true }],
    ] as const) {
      const body = render({ label: 'Ran a command', openness, chosen });
      assert.ok(body.textContent?.includes('Ran a command'), body.innerHTML);
      assert.ok(body.querySelector('[data-probe="detail"]'), body.innerHTML);
    }
  });

  test('a block whose work is active shimmers on its label, and a settled one does not', () => {
    const active = render({
      label: 'Running',
      openness: { active: true, hasContent: true },
      chosen: null,
    });
    assert.ok(active.querySelector('.shimmer'), active.innerHTML);
    assert.equal(active.querySelector('.shimmer')?.textContent, 'Running');
    const settled = render({
      label: 'Ran',
      openness: { active: false, hasContent: true },
      chosen: null,
    });
    assert.equal(settled.querySelector('.shimmer'), null);
  });
});
