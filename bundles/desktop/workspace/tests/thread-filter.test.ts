// T-4.3.5: the Project sidebar's "Search Threads" filter as a pure rule over
// the Thread tree — which Threads stay drawn and which are drawn expanded.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterThreadTree } from '../src/client/domain/thread-filter.js';
import { threadLevel } from '../src/client/domain/thread-tree.js';
import type { Thread } from '../src/client/domain/workspace.js';

const thread = (id: string, name: string, parentThreadId?: string): Thread => ({
  id,
  projectId: 'p',
  ...(parentThreadId === undefined ? {} : { parentThreadId }),
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
});

// The tree of `99:8035`: Plan › Build › Validate, Plan › Review, Audit, and a
// Thread without a name.
const threads = [
  thread('plan', 'Plan the checkout flow'),
  thread('build', 'Build the payment form', 'plan'),
  thread('validate', 'Validate card numbers', 'build'),
  thread('review', 'Review error copy', 'plan'),
  thread('audit', 'Accessibility audit'),
  thread('nameless', ''),
];
const nodes = threadLevel(threads, undefined, 'p').nodes;

const sorted = (ids: ReadonlySet<string>): string[] => [...ids].sort();

test('"untitled" matches a Thread without a name, by the name its row shows', () => {
  const filter = filterThreadTree(nodes, 'untitled');

  assert.deepEqual(sorted(filter.shown), ['nameless']);
  assert.deepEqual(sorted(filter.expanded), []);
});

test('"PAY" matches "Build the payment form" whatever the case, with its ancestor', () => {
  const filter = filterThreadTree(nodes, 'PAY');

  assert.deepEqual(sorted(filter.shown), ['build', 'plan']);
  assert.deepEqual(sorted(filter.expanded), ['plan']);
});

test('a match at depth 2 puts both ancestors in shown and expanded', () => {
  const filter = filterThreadTree(nodes, 'card numbers');

  assert.deepEqual(sorted(filter.shown), ['build', 'plan', 'validate']);
  assert.deepEqual(sorted(filter.expanded), ['build', 'plan']);
});

test('a Thread that matches keeps its own children out unless they match', () => {
  const filter = filterThreadTree(nodes, 'plan the');

  assert.deepEqual(sorted(filter.shown), ['plan']);
  assert.deepEqual(sorted(filter.expanded), []);
});

test('no match leaves both sets empty', () => {
  const filter = filterThreadTree(nodes, 'zzz');

  assert.deepEqual(sorted(filter.shown), []);
  assert.deepEqual(sorted(filter.expanded), []);
});
