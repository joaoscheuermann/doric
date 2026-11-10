// Where git's region items go (T-2.5, spec §2.6, S9): the working directory
// and branch sit in the Files column's footer (`layout.panel.footer`), no
// longer in the conversation's footer band (`layout.footer`).
//
// `gitRegions` lives in the client entry point, whose import graph reaches the
// elements; they read browser globals such as `navigator` only when they run
// (D10-7), but their types need the DOM library, which the spec build does
// not otherwise load.

/// <reference lib="dom" />

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gitRegions } from '../src/client/index.js';

/** The regions git adds the item `id` to. */
const regionsOf = (id: string): string[] =>
  gitRegions
    .filter((entry) => entry.item.id === id)
    .map((entry) => entry.region);

test('the working directory item is in the Files footer, not the conversation footer', () => {
  assert.deepEqual(regionsOf('git-cwd'), ['layout.panel.footer']);
});
