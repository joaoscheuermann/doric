/**
 * Every window loads the one shell page, so the path main opened a window at
 * is what decides which legacy surface it mounts: the settings window opens
 * at `/settings` (or a section under it), the workspace at its last path or
 * `/`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { legacyRootFor } from '../src/legacy/root';

describe('legacy mount root', () => {
  test('the workspace window mounts the workspace at the root path', () => {
    assert.equal(legacyRootFor('/'), 'workspace');
  });

  test('the settings window mounts settings at /settings', () => {
    assert.equal(legacyRootFor('/settings'), 'settings');
  });

  test('a section under /settings is still the settings window', () => {
    assert.equal(legacyRootFor('/settings/providers'), 'settings');
    assert.equal(legacyRootFor('/settings/'), 'settings');
  });

  test('a workspace path restored from the last session mounts the workspace', () => {
    assert.equal(legacyRootFor('/projects/p/threads/t'), 'workspace');
  });

  test('a path that only starts with the word settings is not settings', () => {
    assert.equal(legacyRootFor('/settingsx'), 'workspace');
    assert.equal(legacyRootFor('/projects/settings'), 'workspace');
  });
});

describe('shell page template', () => {
  // Main renders this template for every window and injects the import map
  // and the theme into its head, so it carries what both former pages shared.
  const html = readFileSync(join(__dirname, '../../src/shell.html'), 'utf8');

  test('is the dark Doric page with one empty root', () => {
    assert.match(html, /<html lang="en" class="dark">/);
    assert.match(html, /<title>Doric<\/title>/);
    assert.match(html, /<meta name="color-scheme" content="dark" \/>/);
    assert.match(html, /<div id="root"><\/div>/);
  });

  test('names no route, title per window or base URL', () => {
    assert.doesNotMatch(html, /settings/i);
    assert.doesNotMatch(html, /<base\b/);
  });
});
