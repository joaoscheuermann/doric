// C17 (conversation-openui.md D29, openui.md D23): the production build the
// `test` target depends on folds react-lang's development paths away. The
// renderer chunk imports nothing from `@openuidev/devtools`, holds neither the
// dev-tools mount attribute nor any read of `process.env.NODE_ENV`, and the
// client entry imports no OpenUI package.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

/** `dist/` of the bundle: tests run from `dist-tests/tests`. */
const DIST = new URL('../../dist/', import.meta.url);

const read = (path: string): Promise<string> =>
  readFile(new URL(path, DIST), 'utf8');

/** Every module specifier of an ES module's static and dynamic imports and re-exports. */
const specifiersOf = (code: string): string[] => [
  ...[
    ...code.matchAll(
      /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    ),
  ].map((match) => match[1] as string),
  ...[...code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  ),
  ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (match) => match[1] as string,
  ),
];

test('the renderer chunk imports nothing from @openuidev/devtools', async () => {
  const chunk = await read('client/chunks/renderer.js');

  assert.ok(chunk.length > 0);
  assert.deepEqual(
    specifiersOf(chunk).filter((specifier) =>
      specifier.startsWith('@openuidev/devtools'),
    ),
    [],
  );
  assert.equal(chunk.includes('@openuidev/devtools'), false);
});

test('the renderer chunk holds no dev-tools mount and no read of process.env.NODE_ENV', async () => {
  const chunk = await read('client/chunks/renderer.js');

  assert.equal(chunk.includes('data-openui-devtools-auto-mount'), false);
  assert.doesNotMatch(chunk, /process\.env\.NODE_ENV/);
  assert.doesNotMatch(chunk, /process\.env\[\s*["']NODE_ENV["']\s*\]/);
});

test('the client entry imports no @openuidev package', async () => {
  const entry = await read('client/index.js');

  assert.deepEqual(
    specifiersOf(entry).filter((specifier) =>
      specifier.startsWith('@openuidev/'),
    ),
    [],
  );
  assert.equal(/["']@openuidev\//.test(entry), false);
});

// FT8 (openui-diagrams.md F6, F11; UD7, G5, CSP): the layout chunk is its own
// file holding ELK, its source statement and both ELK notices, and nothing the
// packaged CSP refuses; the renderer chunk holds no ELK and loads the layout
// chunk beside it.

test('the layout chunk holds ELK layered, the source statement and both Kiel notices', async () => {
  const chunk = await read('client/chunks/layout.js');

  assert.ok(chunk.includes('org.eclipse.elk.layered'));
  for (const text of [
    'This file contains elkjs 0.11.1 (https://github.com/kieler/elkjs)',
    'elkjs is distributed here under the Eclipse Public License 2.0',
    'Its Source Code is available under',
    'https://github.com/kieler/elkjs/tree/0.11.1',
    'https://github.com/eclipse-elk/elk.',
    'Copyright (c) 2017 Kiel University and others.',
    'Copyright (c) 2021 Kiel University and others.',
  ]) {
    assert.ok(chunk.includes(text), text);
  }
});

// FT8, extended (openui-diagrams-phase2.md F18): the same chunk also lays
// mind maps out with ELK's mrtree.
test('the layout chunk holds ELK mrtree', async () => {
  const chunk = await read('client/chunks/layout.js');

  assert.ok(chunk.includes('org.eclipse.elk.mrtree'));
});

test('the layout chunk holds no new Function(, no eval( and no import', async () => {
  const chunk = await read('client/chunks/layout.js');

  assert.ok(chunk.length > 0);
  assert.equal(chunk.includes('new Function('), false);
  assert.equal(chunk.includes('eval('), false);
  assert.deepEqual(specifiersOf(chunk), []);
  assert.doesNotMatch(chunk, /(?:^|[;}\n])\s*import\s*(?:[\w$*{]|['"])/);
});

test('the renderer chunk holds no ELK and loads ./layout.js', async () => {
  const chunk = await read('client/chunks/renderer.js');

  assert.equal(chunk.includes('org.eclipse.elk'), false);
  assert.ok(chunk.includes('./layout.js'));
});
