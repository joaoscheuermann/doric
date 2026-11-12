/**
 * `ScrollArea` draws the vertical scrollbar alone by default, as the registry
 * does, and adds a horizontal one on `scrollbars="both"` (sidebar alignment
 * §10, D15). Base UI mounts a scrollbar only once it has measured overflow, so
 * static markup shows none for either value; what it does show is that the
 * option never reaches the root element and the children sit in the viewport.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ScrollArea } from 'desktop/ui/scroll-area';
import { Window } from 'happy-dom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** Parses static markup into a document whose elements can be walked. */
const parse = (markup: string): Document => {
  const document = new Window().document;
  document.body.innerHTML = markup;
  return document as unknown as Document;
};

const cases = [
  ['by default', {}],
  ["with scrollbars 'vertical'", { scrollbars: 'vertical' as const }],
  ["with scrollbars 'both'", { scrollbars: 'both' as const }],
] as const;

describe('a scroll area', () => {
  for (const [state, options] of cases) {
    test(`T-4.3: ${state} keeps the option off the root and the children in the viewport`, () => {
      const document = parse(
        renderToStaticMarkup(
          createElement(
            ScrollArea,
            { className: 'min-h-0 flex-1', ...options },
            createElement('ul', { id: 'content' }, 'rows'),
          ),
        ),
      );
      const root = document.querySelector('[data-slot="scroll-area"]');
      assert.ok(root, 'no scroll-area root');
      assert.equal(root.getAttribute('scrollbars'), null);
      assert.ok(root.classList.contains('min-h-0'), 'the className is lost');

      const viewport = root.querySelector('[data-slot="scroll-area-viewport"]');
      assert.ok(viewport, 'no scroll-area viewport');
      assert.equal(
        document.getElementById('content')?.parentElement,
        viewport,
        'the children do not sit in the viewport',
      );
      assert.equal(
        document.querySelectorAll('[data-slot="scroll-area-scrollbar"]').length,
        0,
        'a scrollbar mounted before any overflow was measured',
      );
    });
  }
});
