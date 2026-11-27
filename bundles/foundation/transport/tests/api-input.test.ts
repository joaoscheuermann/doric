import assert from 'node:assert/strict';
import test from 'node:test';

import { nameInput, ok, pageInput, refused } from '../src/host/api/input.js';
import type { LeaseScope, ProjectScope } from '../src/host/api/ports.js';

/*
 * S69 (plan groupF S69, "Move"): the live part of the removed
 * `src/host/routes/input.ts` — the page and name inputs and the `ok`/`refused`
 * answers the operations build — lives in `src/host/api/input.ts` with the same
 * signatures, and the lease scopes of the removed `src/host/services.ts` in
 * `src/host/api/ports.ts`.
 */

const cursor = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf16ff';

void test('pageInput reads limit 50 by default, a cursor UUID when given, and refuses a limit over 100 or a bad cursor', () => {
  assert.deepEqual(pageInput.parse({}), { limit: 50 });
  assert.deepEqual(pageInput.parse({ limit: '7', cursor }), {
    limit: 7,
    cursor,
  });
  assert.equal(pageInput.safeParse({ limit: 101 }).success, false);
  assert.equal(pageInput.safeParse({ limit: 0 }).success, false);
  assert.equal(pageInput.safeParse({ cursor: 'y' }).success, false);
});

void test('nameInput normalises a name and refuses an empty one', () => {
  assert.equal(nameInput.parse('  New  '), 'New');
  assert.equal(nameInput.safeParse('').success, false);
});

void test('ok answers the value with status 200 by default, or the status given; refused answers the error', () => {
  const error = {
    status: 404,
    code: 'project_not_found',
    message: 'The project was not found.',
  };

  assert.deepEqual(ok({ id: 'x' }), {
    kind: 'ok',
    status: 200,
    value: { id: 'x' },
  });
  assert.deepEqual(ok(undefined, 204), {
    kind: 'ok',
    status: 204,
    value: undefined,
  });
  assert.deepEqual(refused(error), { kind: 'refused', error });
});

void test('a lease scope names a Project or a Thread; a Project scope names a Project', () => {
  const scopes: readonly LeaseScope[] = [{ projectId: 'p' }, { threadId: 't' }];
  const project: ProjectScope = { projectId: 'p' };

  assert.deepEqual(scopes, [{ projectId: 'p' }, { threadId: 't' }]);
  assert.deepEqual(project, { projectId: 'p' });
});
