/**
 * The palette is the Doric-UI Figma file's, value for value.
 *
 * `fixtures/figma-variables.json` is what Figma's `get_variable_defs` returned
 * for the light (`11:6`) and dark (`11:311`) frames, cut to the colour
 * variables. Figma writes a transparent colour as `#00000000`, which the module
 * states as `transparent`; both are the same paint.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { tokens } from 'desktop/ui';

interface FigmaVariables {
  readonly variants: Readonly<
    Record<
      'light' | 'dark',
      { readonly variables: Readonly<Record<string, string>> }
    >
  >;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const figma = JSON.parse(
  readFileSync(
    join(packageRoot, 'tests/fixtures/figma-variables.json'),
    'utf8',
  ),
) as FigmaVariables;

/**
 * A colour as either side writes it, in the one spelling both share: lowercase
 * hex, with Figma's `#00000000` read as the module's `transparent`.
 */
const paint = (value: string | undefined): string | undefined =>
  value === '#00000000' ? 'transparent' : value;

/** Every module token but the shadows is a colour. */
const isColour = (name: string): boolean =>
  !name.startsWith('--shadow') && name !== '--paper-shadow-control';

for (const variant of ['light', 'dark'] as const) {
  describe(`the ${variant} palette against Figma`, () => {
    const stated = new Map(Object.entries(tokens.variants[variant]));
    const named = Object.fromEntries(
      Object.entries(figma.variants[variant].variables).map(
        ([reference, value]) => [reference.slice('var('.length, -1), value],
      ),
    );

    test('every Figma colour is the token of the same name', () => {
      const fromFigma = Object.fromEntries(
        Object.entries(named).map(([name, value]) => [name, paint(value)]),
      );
      const fromModule = Object.fromEntries(
        Object.keys(named).map((name) => [name, paint(stated.get(name))]),
      );

      assert.deepEqual(fromModule, fromFigma);
    });

    test('the module states no colour Figma does not', () => {
      const extra = [...stated.keys()]
        .filter(isColour)
        .filter((name) => !(name in named));

      assert.deepEqual(extra, []);
    });
  });
}
