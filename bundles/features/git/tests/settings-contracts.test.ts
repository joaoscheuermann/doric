// Bundle isolation 6(c): `settings` publishes `settings/contracts`, so git
// takes `settings.config/v1` from it instead of keeping a copy (D32: a value,
// since git requires the contract), and checks its literal of the settings
// window's navigation slot against `SETTINGS_SECTIONS` (AC6.4).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string): string =>
  readFileSync(`bundles/features/git/${path}`, 'utf8');

test('the Versioning section takes SettingsConfigV1 from settings/contracts, and git keeps no copy of it', () => {
  assert.match(
    read('src/client/settings/versioning.tsx'),
    /import\s*\{[^}]*\bSettingsConfigV1\b[^}]*\}\s*from\s*['"]settings\/contracts['"]/,
    'versioning.tsx does not import SettingsConfigV1 from settings/contracts.',
  );

  const peers = read('src/client/api/peers.ts');
  assert.doesNotMatch(peers, /\bSettingsConfigV1\b/);
  assert.doesNotMatch(peers, /\binterface\s+SettingsConfig\b/);
});

test("the Versioning link's region literal is checked against SETTINGS_SECTIONS", () => {
  const entry = read('src/client/index.ts');
  assert.match(
    entry,
    /region:\s*'settings\.sections'\s+satisfies\s+typeof\s+SETTINGS_SECTIONS/,
  );
  assert.match(
    entry,
    /import\s+type\s*\{[^}]*\bSETTINGS_SECTIONS\b[^}]*\}\s*from\s*['"]settings\/contracts['"]/,
  );
});

test('git lists settings as a dev dependency, for its types and its one ref', () => {
  const manifest = JSON.parse(read('package.json')) as {
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  assert.equal(manifest.devDependencies?.settings, '0.0.1');
});
