/**
 * `ModelIcon` (`desktop/ui/model-icon`, AC6.6) is a model's or a provider's
 * 16px icon: the SVG is drawn as a mask in the text colour, hidden from
 * assistive technology, and never reaches the document as elements. Without an
 * SVG it is an empty slot of the same size.
 *
 * The import resolves through the package's export map, so this exercises the
 * file the windows load.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ModelIcon } from 'desktop/ui/model-icon';
import { Window } from 'happy-dom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>';

/** The icon rendered alone, parsed into a document; its root element. */
const render = (props: Parameters<typeof ModelIcon>[0]): HTMLElement => {
  const document = new Window().document;
  document.body.innerHTML = renderToStaticMarkup(
    createElement(ModelIcon, props),
  );
  const icon = document.body.firstElementChild;
  assert.ok(icon, 'nothing rendered');
  assert.equal(document.body.childElementCount, 1);
  return icon as unknown as HTMLElement;
};

describe('ModelIcon', () => {
  test('with an SVG, draws it as a mask in the text colour', () => {
    const icon = render({ svg });
    assert.ok(icon.classList.contains('bg-current'), icon.className);
    assert.ok(icon.classList.contains('size-4'), icon.className);
    const style = icon.getAttribute('style') ?? '';
    assert.match(style, /mask:\s*url\("data:image\/svg\+xml,/u);
    assert.ok(
      style.includes(encodeURIComponent(svg)),
      `the mask does not hold the SVG: ${style}`,
    );
  });

  test('without an SVG, is an empty slot of the same size', () => {
    const icon = render({});
    assert.ok(icon.classList.contains('size-4'), icon.className);
    assert.ok(!icon.classList.contains('bg-current'), icon.className);
    assert.equal(icon.getAttribute('style'), null);
    assert.equal(icon.childNodes.length, 0);
  });

  test('is hidden from assistive technology and marked as a model icon', () => {
    for (const icon of [render({ svg }), render({})]) {
      assert.equal(icon.tagName, 'SPAN');
      assert.equal(icon.getAttribute('aria-hidden'), 'true');
      assert.equal(icon.getAttribute('data-slot'), 'model-icon');
    }
  });

  test('inlineStart marks it as a leading icon, and it is unmarked without it', () => {
    assert.equal(
      render({ svg, inlineStart: true }).getAttribute('data-icon'),
      'inline-start',
    );
    assert.equal(render({ svg }).getAttribute('data-icon'), null);
  });

  test('no element of the SVG reaches the document', () => {
    const icon = render({ svg });
    assert.equal(icon.querySelector('svg, path'), null);
    assert.equal(icon.childNodes.length, 0);
  });

  test('keeps the caller’s classes', () => {
    const icon = render({ svg, className: 'text-primary' });
    assert.ok(icon.classList.contains('text-primary'), icon.className);
  });
});
