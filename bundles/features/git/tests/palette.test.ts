/**
 * The colours of a change, which the git bundle states in its own stylesheet
 * (BWP-11 moved them out of the desktop palette). The values are the palette's:
 * a light window and a dark one read the same five variables they read before.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChangeCounts } from '../src/client/changes/change-counts.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const stylesheet = readFileSync(
  join(packageRoot, 'src/client/styles.css'),
  'utf8',
);

/** The custom properties one selector block of the stylesheet declares. */
const block = (selector: string): Record<string, string> => {
  const start = stylesheet.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `the stylesheet states ${selector}`);
  const body = stylesheet.slice(
    stylesheet.indexOf('{', start) + 1,
    stylesheet.indexOf('}', start),
  );
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name ?? '',
      (value ?? '').trim(),
    ]),
  );
};

describe('the change colours the stylesheet states', () => {
  test('the light window states the palette values on :root', () => {
    assert.deepEqual(block(':root'), {
      '--git-added': 'oklch(0.47 0.14 150)',
      '--git-modified': 'oklch(0.5 0.13 82)',
      '--git-deleted': 'oklch(0.52 0.19 27)',
      '--git-renamed': 'oklch(0.48 0.16 255)',
      '--git-conflicted': 'oklch(0.5 0.2 320)',
    });
  });

  test('the dark window states the palette values on .dark', () => {
    assert.deepEqual(block('.dark'), {
      '--git-added': 'oklch(0.76 0.16 150)',
      '--git-modified': 'oklch(0.83 0.16 85)',
      '--git-deleted': 'oklch(0.74 0.17 27)',
      '--git-renamed': 'oklch(0.76 0.14 255)',
      '--git-conflicted': 'oklch(0.78 0.18 320)',
    });
  });
});

describe('the change counts', () => {
  const markup = (added: number, removed: number) =>
    renderToStaticMarkup(createElement(ChangeCounts, { added, removed }));

  test('colour a change in the added and deleted colours', () => {
    const html = markup(3, 1);
    assert.match(html, /text-\[var\(--git-added\)\][^>]*>\+3</u);
    assert.match(html, /text-\[var\(--git-deleted\)\][^>]*>−1</u);
  });

  test('stay muted when nothing changed', () => {
    const html = markup(0, 0);
    assert.doesNotMatch(html, /--git-/u);
    assert.equal(html.match(/text-muted-foreground/gu)?.length, 2);
  });
});
