// The view window's content rules, without Electron: the URL a host-relative
// path composes against the app's host origin, the origin a view may stay
// inside, and what `doric.windows/v1.navigate` decides for a key.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  composeViewUrl,
  navigateDisposition,
  viewNavigationAllowed,
  viewOriginOf,
} from '../src/platform/windows/view';

const HOST = 'http://127.0.0.1:3000';

describe('a view window composes its URL against the host origin', () => {
  test('the loopback default resolves the host-relative path', () => {
    assert.equal(
      composeViewUrl(HOST, '/screen/tok/connect.html'),
      'http://127.0.0.1:3000/screen/tok/connect.html',
    );
  });

  test('a remote host origin is whatever hostUrl names, not the app', () => {
    assert.equal(
      composeViewUrl('https://doric.example.com:8443', '/screen/x/'),
      'https://doric.example.com:8443/screen/x/',
    );
  });

  test('a path is host-relative: it never overrides the origin', () => {
    // A protocol-relative path still resolves under the host origin's scheme.
    assert.equal(
      composeViewUrl('https://host.example', '/screen/x/'),
      'https://host.example/screen/x/',
    );
    assert.equal(viewOriginOf(HOST, '/screen/x/'), 'http://127.0.0.1:3000');
  });
});

describe('a view window may navigate inside its own origin only', () => {
  const origin = viewOriginOf(HOST, '/screen/tok/');

  test('a same-origin redirect is allowed', () => {
    assert.equal(
      viewNavigationAllowed(
        'http://127.0.0.1:3000/screen/tok/connect.html',
        origin,
      ),
      true,
    );
  });

  test('another origin is refused', () => {
    assert.equal(
      viewNavigationAllowed('https://elsewhere.example/', origin),
      false,
    );
    assert.equal(
      viewNavigationAllowed('http://127.0.0.1:3001/x', origin),
      false,
    );
  });

  test('an unparseable URL is refused', () => {
    assert.equal(viewNavigationAllowed('not a url', origin), false);
  });
});

describe('the navigate disposition for a key', () => {
  test('a view window loads the new host path', () => {
    assert.deepEqual(navigateDisposition({ kind: 'view' }, HOST, '/screen/2'), {
      kind: 'view',
      url: 'http://127.0.0.1:3000/screen/2',
    });
  });

  test('a path window is not navigable this way', () => {
    assert.deepEqual(navigateDisposition({ kind: 'path' }, HOST, '/screen/2'), {
      kind: 'path_window',
    });
  });

  test('an unknown key has no window', () => {
    assert.deepEqual(navigateDisposition(undefined, HOST, '/screen/2'), {
      kind: 'absent',
    });
  });
});
