// PC32 (papercraft-openui.md D6, D23): the program frame as the production
// build emits it, `dist/client/frames/openui.js` (the `test` target depends on
// the build). It is a browser build: the bundled react-lang neither imports
// OpenUI's devtools nor mounts their widget, `process.env.NODE_ENV` was
// replaced at build time, and it carries the three sheets it loads as text.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** The bundle's root, from `dist-tests/tests/client/`. */
const bundleRoot = new URL('../../../', import.meta.url);
const built = new URL('dist/client/frames/openui.js', bundleRoot);

const readBuilt = async (): Promise<string> => {
  try {
    return await readFile(built, 'utf8');
  } catch (error) {
    throw new Error(
      `the build emitted no program frame at ${fileURLToPath(built)}: ${String(error)}`,
    );
  }
};

/** The three sheets the frame loads (D6, D31), from their sources. */
const sheetSources = (): readonly string[] => [
  fileURLToPath(
    new URL('../../../packages/desktop/src/styles/tokens.css', bundleRoot),
  ),
  createRequire(import.meta.url).resolve(
    '@openuidev/react-ui/layered/styles/index.css',
  ),
  fileURLToPath(new URL('../openui/src/client/tokens.css', bundleRoot)),
];

/**
 * Declarations of a sheet that survive being embedded as a JS string
 * unchanged (no quote, backslash or line break): its first, middle and last
 * such declaration, so the whole sheet is checked, not one end of it.
 */
const telltalesOf = (sheet: string): readonly string[] => {
  const declarations = sheet
    .split(/[;{}\n]/)
    .map((part) => part.trim())
    .filter(
      (part) =>
        part.length >= 16 &&
        part.length <= 200 &&
        part.includes(':') &&
        !/["'`\\]/.test(part) &&
        !part.includes('/*') &&
        !part.startsWith('*'),
    );

  return [
    ...new Set(
      [0, Math.floor(declarations.length / 2), declarations.length - 1]
        .map((index) => declarations[index])
        .filter((part): part is string => part !== undefined),
    ),
  ];
};

test('PC32: the built frame imports nothing from @openuidev/devtools and holds no auto-mount marker', async () => {
  const frame = await readBuilt();

  assert.equal(frame.includes('@openuidev/devtools'), false);
  assert.equal(frame.includes('data-openui-devtools-auto-mount'), false);
});

test('PC32: the built frame holds no process.env.NODE_ENV in either spelling', async () => {
  const frame = await readBuilt();

  assert.equal(/process\.env\.NODE_ENV/.test(frame), false);
  assert.equal(/process\.env\[\s*["']NODE_ENV["']\s*\]/.test(frame), false);
});

test("PC32: the built frame holds the three sheets' text", async () => {
  const frame = await readBuilt();

  for (const path of sheetSources()) {
    const telltales = telltalesOf(await readFile(path, 'utf8'));

    assert.ok(telltales.length > 0, `${path} gives no line to look for`);
    for (const line of telltales) {
      assert.ok(frame.includes(line), `the frame lacks ${path}'s "${line}"`);
    }
  }
});
