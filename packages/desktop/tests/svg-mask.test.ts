import assert from 'node:assert/strict';
import { test } from 'node:test';

import { svgMask } from '../src/svg-mask.js';

const prefix = 'url("data:image/svg+xml,';
const suffix = '")';

/** The data URL's payload: what lies between the prefix and the suffix. */
const payloadOf = (mask: string): string => {
  assert.ok(mask.startsWith(prefix), mask);
  assert.ok(mask.endsWith(suffix), mask);

  return mask.slice(prefix.length, mask.length - suffix.length);
};

test('svgMask wraps the SVG in a quoted data URL that decodes back to it', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';

  assert.equal(decodeURIComponent(payloadOf(svgMask(svg))), svg);
});

test('svgMask leaves no quote, backslash, hash, percent or line break of the SVG unescaped', () => {
  const svg =
    '<svg viewBox="0 0 24 24">\n<path fill="#000" d="M1 1"/>\r\n<text>100% \\ \' (a)</text></svg>';
  const payload = payloadOf(svgMask(svg));

  for (const raw of ['"', '\\', '#', '\n', '\r']) {
    assert.equal(payload.includes(raw), false, JSON.stringify(raw));
  }
  // Every `%` left in the payload starts an escape, so none is the SVG's own.
  assert.equal(/%(?![0-9A-Fa-f]{2})/.test(payload), false);
  assert.equal(decodeURIComponent(payload), svg);
});
