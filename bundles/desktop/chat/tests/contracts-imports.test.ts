// What a bundle loads when it imports chat's contracts: the reader's name comes
// from the platform's identity mark, and nothing on that path brings React.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bundleRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every module specifier the emitted contracts import or re-export from. */
const specifiers = (): string[] => {
  const source = readFileSync(
    join(bundleRoot, 'dist/contracts/index.js'),
    'utf8',
  );
  return [
    ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g),
  ].map((match) => match[1]);
};

test('the emitted contracts import no React', () => {
  const react = specifiers().filter(
    (specifier) =>
      specifier === 'react' ||
      specifier.startsWith('react/') ||
      specifier.startsWith('react-dom'),
  );

  assert.deepEqual(react, []);
});

test('the emitted contracts take from desktop/ui only the identity mark', () => {
  const desktopUi = [
    ...new Set(
      specifiers().filter(
        (specifier) =>
          specifier === 'desktop/ui' || specifier.startsWith('desktop/ui/'),
      ),
    ),
  ];

  assert.deepEqual(desktopUi, ['desktop/ui/identity']);
});
