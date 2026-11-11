/**
 * The tree's geometry from Figma `16:104`: a row at `depth` starts 6 px from
 * the edge plus 20 px per level, and the guide for each level sits at 14, 34,
 * 54 px — through the centre of the parent's 16 px lead slot.
 *
 * Lengths are compared by what they resolve to at 16 px per rem, so a `rem`,
 * `px` or `calc()` spelling of the same length passes alike.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { indentation, TreeGuides } from 'desktop/ui/panels';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const remInPx = 16;

/** Resolves a CSS length (`rem`, `px`, or a `calc()` sum of them) to pixels. */
const pixels = (length: string): number => {
  const body = length
    .trim()
    .replace(/^calc\((.*)\)$/u, '$1')
    .replace(/\s+/gu, '');
  const terms = body.match(/[+-]?[\d.]+(?:rem|px)?/gu);
  assert.ok(terms, `not a length: ${length}`);
  assert.equal(terms.join(''), body, `unsupported length: ${length}`);
  return terms.reduce((sum, term) => {
    const value = Number.parseFloat(term);
    return sum + (term.endsWith('rem') ? value * remInPx : value);
  }, 0);
};

describe('the indentation of a tree row', () => {
  test('starts 6 px in at the root and steps 20 px per level', () => {
    assert.equal(pixels(indentation(0)), 6);
    assert.equal(pixels(indentation(1)), 26);
    assert.equal(pixels(indentation(3)), 66);
  });
});

describe('the depth guides of a tree row', () => {
  test('draw one guide per level at 14, 34 and 54 px', () => {
    const markup = renderToStaticMarkup(
      createElement(TreeGuides, { depth: 3 }),
    );
    const lefts = [...markup.matchAll(/left:\s*([^;"]+)/gu)].map((found) =>
      pixels(found[1] ?? ''),
    );
    assert.deepEqual(lefts, [14, 34, 54]);
  });

  test('draw nothing at the root', () => {
    assert.equal(
      renderToStaticMarkup(createElement(TreeGuides, { depth: 0 })),
      '',
    );
  });
});
