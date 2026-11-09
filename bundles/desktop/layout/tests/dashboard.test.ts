// The /projects dashboard: which `layout.dashboard.page` entry draws in place
// of the project list, and the search shortcut's hint per platform.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RegionEntry } from 'bundle/contracts';

import {
  dashboardPage,
  searchShortcutKeys,
  searchShortcutLabel,
} from '../src/client/domain/dashboard.js';

const provider: RegionEntry = {
  id: 'settings.provider',
  tag: 'settings-dashboard-provider',
  owner: 'settings',
};
const other: RegionEntry = {
  id: 'other.page',
  tag: 'other-dashboard-page',
  owner: 'other',
};
const items: readonly RegionEntry[] = [other, provider];

describe('dashboard page', () => {
  test('no active page draws the project list', () => {
    assert.equal(dashboardPage(items, undefined), undefined);
  });

  test('the active page is the entry with its id', () => {
    assert.equal(dashboardPage(items, 'settings.provider'), provider);
  });

  test('an active id no entry has draws the project list', () => {
    assert.equal(dashboardPage(items, 'gone'), undefined);
  });
});

describe('search shortcut label', () => {
  test('Apple platforms show ⌘F', () => {
    for (const platform of ['MacIntel', 'iPhone', 'iPad']) {
      assert.equal(searchShortcutLabel(platform), '⌘F', platform);
    }
  });

  test('other platforms show Ctrl+F', () => {
    for (const platform of ['Win32', 'Linux x86_64', '']) {
      assert.equal(searchShortcutLabel(platform), 'Ctrl+F', platform);
    }
  });
});

// §2.8, Figma `34:12218`: the sidebar search draws its shortcut as two keys.
describe('search shortcut keys', () => {
  test('Apple platforms show the keys ⌘ and F', () => {
    for (const platform of ['MacIntel', 'iPhone', 'iPad']) {
      assert.deepEqual(searchShortcutKeys(platform), ['⌘', 'F'], platform);
    }
  });

  test('other platforms show the keys Ctrl and F', () => {
    for (const platform of ['Win32', 'Linux x86_64', '']) {
      assert.deepEqual(searchShortcutKeys(platform), ['Ctrl', 'F'], platform);
    }
  });
});
