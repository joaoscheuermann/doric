import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Project, Thread } from '../src/contracts/model.js';
import {
  sortActivity,
  summarizeActivity,
} from '../src/host/domain/activity.js';

const project = (id: string, updatedAt: string) =>
  ({ id, updatedAt }) as Project;
const thread = (id: string, updatedAt: string, state: Thread['state']) =>
  ({ id, updatedAt, state }) as Thread;

test('activity uses the newest Project or Thread date and selects the newest nonterminal Thread', () => {
  const result = summarizeActivity(project('p', '2026-01-04'), [
    thread('old', '2026-01-02', 'ready'),
    thread('done', '2026-01-09', 'failed'),
    thread('active', '2026-01-07', 'running'),
  ]);
  assert.equal(result.activityAt, '2026-01-09');
  assert.equal(result.latestActiveThreadId, 'active');
});

test('activity keeps a Project with no active Threads and orders equal dates by ID', () => {
  const first = summarizeActivity(project('a', '2026-01-03'), [
    thread('done', '2026-01-02', 'cancelled'),
  ]);
  const second = summarizeActivity(project('b', '2026-01-03'), []);
  assert.equal(first.latestActiveThreadId, undefined);
  assert.deepEqual(
    sortActivity([second, first]).map(({ project }) => project.id),
    ['a', 'b'],
  );
});
