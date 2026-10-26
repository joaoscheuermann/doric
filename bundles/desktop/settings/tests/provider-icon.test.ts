// What a provider is drawn as in the dashboard: a local machine for an
// endpoint on this computer, its own brand for a known kind, a server for
// any other kind, and the site a kind's page links to.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isLocalEndpoint,
  providerMark,
  providerSite,
} from '../src/client/domain/provider-icon.js';

describe('local endpoints', () => {
  test('an endpoint on this machine is local', () => {
    for (const endpoint of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234',
      'http://0.0.0.0:8080',
      'http://[::1]:11434',
    ]) {
      assert.equal(isLocalEndpoint(endpoint), true, endpoint);
    }
  });

  test('a remote, absent or unreadable endpoint is not local', () => {
    for (const endpoint of [
      'https://openrouter.ai/api/v1',
      'http://localhost.example.com',
      '',
      undefined,
      'not a url',
    ]) {
      assert.equal(isLocalEndpoint(endpoint), false, String(endpoint));
    }
  });
});

describe('provider marks', () => {
  test('a local endpoint is drawn as local whatever the kind', () => {
    assert.equal(providerMark('openai', 'http://localhost:1234/v1'), 'local');
  });

  test('a known kind away from this machine is drawn by its own mark', () => {
    for (const kind of ['openai', 'openrouter', 'claude', 'codex']) {
      assert.equal(providerMark(kind, 'https://example.com/v1'), kind, kind);
      assert.equal(providerMark(kind, undefined), kind, kind);
    }
  });

  test('a kind with no mark of its own is drawn as a server', () => {
    assert.equal(providerMark('acme', undefined), 'server');
  });
});

describe('provider sites', () => {
  test('OpenRouter links to its site; a kind without one links nowhere', () => {
    assert.deepEqual(providerSite('openrouter'), {
      url: 'https://openrouter.ai',
      label: 'Open OpenRouter',
    });
    assert.equal(providerSite('openai'), undefined);
  });
});
