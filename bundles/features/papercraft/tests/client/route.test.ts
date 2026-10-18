// The canvas window's route: it must stand alone, so the workspace layout
// never mounts around the canvas and never rewrites the window's path to the
// Thread its restored selection names.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canvasRouteOf } from '../../src/client/index.js';
import { CANVAS_ROUTE, canvasPathOf } from '../../src/contracts/index.js';

test('the canvas route is its own root and hands the canvas its path params', () => {
  const made: Readonly<Record<string, string>>[] = [];
  const route = canvasRouteOf((params) => {
    made.push(params);
    return {};
  });

  assert.equal(route.path, CANVAS_ROUTE);
  assert.equal(route.parent, undefined);

  const params = { projectId: 'p1', threadId: 't1', artifactId: 'a-1' };
  route.create({
    path: canvasPathOf(params),
    pattern: CANVAS_ROUTE,
    params,
  });

  assert.deepEqual(made, [params]);
});
