// The route matcher's edge rules (D9-18): pathname only, one trailing slash
// stripped, empty segments and malformed escapes never match, static beats a
// parameter at the first difference, equal shapes conflict, and the chain of
// a route follows registered parents root-first.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isContractError, type RouteRegistration } from 'bundle/contracts';

import {
  chainOf,
  compile,
  conflicts,
  match,
  normalizePath,
} from '../../src/client/route-match.js';

const route = (path: string, parent?: string): RouteRegistration => ({
  path,
  create: () => ({}),
  ...(parent === undefined ? {} : { parent }),
});

const compiled = (...paths: (string | [string, string])[]) =>
  paths.map((path) =>
    Array.isArray(path)
      ? compile(route(path[0], path[1]), 'x')
      : compile(route(path), 'x'),
  );

void test('a trailing slash is stripped once, except for the root', () => {
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('/settings/'), '/settings');
  assert.equal(normalizePath('/settings'), '/settings');

  const routes = compiled('/settings');

  assert.equal(match(routes, '/settings/')?.match.pattern, '/settings');
  assert.equal(match(routes, '/settings//'), undefined);
});

void test('a static segment beats a parameter at the first difference', () => {
  const routes = compiled('/projects/:projectId', '/projects/new');

  assert.equal(match(routes, '/projects/new')?.match.pattern, '/projects/new');
  assert.deepEqual(match(routes, '/projects/p1')?.match.params, {
    projectId: 'p1',
  });

  const later = compiled('/:section/tools', '/settings/:id');

  assert.equal(match(later, '/settings/tools')?.match.pattern, '/settings/:id');
});

void test('parameters are decoded and a malformed escape does not match', () => {
  const routes = compiled('/threads/:threadId');

  assert.deepEqual(match(routes, '/threads/a%20b')?.match.params, {
    threadId: 'a b',
  });
  assert.equal(match(routes, '/threads/%E0%A4%A'), undefined);
});

void test('an empty segment or a different length never matches', () => {
  const routes = compiled('/projects/:projectId/threads/:threadId');

  assert.equal(match(routes, '/projects//threads/t1'), undefined);
  assert.equal(match(routes, '/projects/p1/threads'), undefined);
  assert.equal(match(routes, '/projects/p1/threads/t1/extra'), undefined);
});

void test('the root matches only the root', () => {
  const routes = compiled('/');

  assert.equal(match(routes, '/')?.match.pattern, '/');
  assert.equal(match(routes, '/anything'), undefined);
});

void test('patterns with the same shape conflict; different statics do not', () => {
  const [a, b, c, d] = compiled(
    '/projects/:projectId',
    '/projects/:id/',
    '/projects/new',
    '/threads/:id',
  );

  assert.equal(conflicts(a as never, b as never), true);
  assert.equal(conflicts(a as never, c as never), false);
  assert.equal(conflicts(a as never, d as never), false);
});

void test('a malformed pattern or a repeated parameter is invalid input', () => {
  for (const path of ['settings', '/a//b', '/a/:', '/a/:id/:id']) {
    assert.throws(
      () => compile(route(path), 'x'),
      (error: unknown) =>
        isContractError(error) && error.code === 'invalid_input',
      path,
    );
  }
});

void test('the chain runs root-first with each parent restricted to its params', () => {
  const routes = compiled(
    '/',
    ['/projects/:projectId', '/'],
    ['/projects/:projectId/threads/:threadId', '/projects/:projectId'],
  );
  const found = match(routes, '/projects/p1/threads/t1');

  assert.ok(found);

  const chain = chainOf(routes, found);

  assert.deepEqual(
    chain.map((entry) => [entry.match.pattern, entry.match.params]),
    [
      ['/', {}],
      ['/projects/:projectId', { projectId: 'p1' }],
      [
        '/projects/:projectId/threads/:threadId',
        { projectId: 'p1', threadId: 't1' },
      ],
    ],
  );
});

void test('a missing parent starts the chain at the route; a cycle ends it', () => {
  const orphan = compiled(['/settings/:id', '/settings']);
  const found = match(orphan, '/settings/tools');

  assert.ok(found);
  assert.deepEqual(
    chainOf(orphan, found).map((entry) => entry.match.pattern),
    ['/settings/:id'],
  );

  const cycle = compiled(['/a', '/b'], ['/b', '/a']);
  const inCycle = match(cycle, '/a');

  assert.ok(inCycle);
  assert.deepEqual(
    chainOf(cycle, inCycle).map((entry) => entry.match.pattern),
    ['/b', '/a'],
  );
});
