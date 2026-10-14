// windows/v1 1.1.0 (packages/bundle): a window request names exactly one
// content kind — an app route the window's shell renders, or a page on the
// host the window's own `webContents` loads in its own session.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type OpenWindowRequest,
  openWindowRequestSchema,
  type PathWindowRequest,
  pathWindowRequestSchema,
  type ViewWindowRequest,
  viewWindowRequestSchema,
  windowsMethods,
} from '../src/contracts/index.js';
import { platformContracts } from '../src/contracts/platform.js';

const pathRequest: PathWindowRequest = {
  key: 'diff:t1:repo',
  path: '/git/diff/t1/repo',
  primary: false,
};

const viewRequest: ViewWindowRequest = {
  key: 'screen:p1',
  view: {
    path: '/screen/token/',
    partition: 'screen:p1',
    title: 'Project screen',
  },
  primary: false,
};

void test('an app route window and a host page window both parse', () => {
  assert.deepEqual(openWindowRequestSchema.parse(pathRequest), pathRequest);
  assert.deepEqual(openWindowRequestSchema.parse(viewRequest), viewRequest);
});

void test('a request names one content kind: the other kind and no kind are refused', () => {
  const accepts = (value: unknown) =>
    openWindowRequestSchema.safeParse(value).success;

  assert.equal(
    accepts({
      key: 'k',
      path: '/a',
      view: { path: '/screen/t/', partition: 'p' },
    }),
    false,
  );
  assert.equal(accepts({ key: 'k', path: '/a', title: 't' }), false);
  assert.equal(accepts({ key: 'k' }), false);
  assert.equal(accepts({ key: 'k', view: { path: '/screen/t/' } }), false);
  assert.equal(
    accepts({ key: 'k', view: { path: 'screen/t/', partition: 'p' } }),
    false,
  );
  assert.equal(accepts({ key: 'k', path: '/a', unknown: 1 }), false);
});

void test('a view window keeps the appearance and the primary flag of any window', () => {
  const either: OpenWindowRequest = viewRequest;
  const parsed = openWindowRequestSchema.parse({
    ...either,
    appearance: { titleBar: 'none', background: 'window' },
  });

  assert.deepEqual(parsed, {
    ...viewRequest,
    appearance: { titleBar: 'none', background: 'window' },
  });
});

void test('both services validate with the same two strict shapes', () => {
  const schemas = [
    windowsMethods.open.input,
    platformContracts['doric.windows/v1'].methods.open.input,
  ];

  for (const schema of schemas) {
    assert.equal(schema.safeParse(pathRequest).success, true);
    assert.equal(schema.safeParse(viewRequest).success, true);
    assert.equal(schema.safeParse({ key: 'k' }).success, false);
    assert.equal(
      schema.safeParse({
        key: 'k',
        path: '/a',
        view: { path: '/screen/t/', partition: 'p' },
      }).success,
      false,
    );
  }

  assert.equal(pathWindowRequestSchema.safeParse(viewRequest).success, false);
  assert.equal(viewWindowRequestSchema.safeParse(pathRequest).success, false);
});
