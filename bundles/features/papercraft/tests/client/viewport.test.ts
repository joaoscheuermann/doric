// The dot grid of the canvas (`surface/viewport.ts`): it marks the crossings
// and rides the viewport. The viewport math itself is `desktop/ui/viewport`,
// tested in packages/desktop/tests/viewport.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GRID_MAJOR_EVERY,
  GRID_STEP,
  gridBackground,
  IDENTITY,
} from '../../src/client/surface/viewport.js';

test('the dot grid marks the crossings and rides the viewport', () => {
  const layers = (value: string) => value.split(/,\s*/);
  const images = (value: string) => value.match(/radial-gradient\(/g)?.length;

  // At identity a major dot every four steps and a minor dot every step,
  // each tile centred on the crossing at content (0, 0).
  const still = gridBackground(IDENTITY);
  const major = GRID_STEP * GRID_MAJOR_EVERY;
  assert.equal(images(still.backgroundImage), 2);
  assert.deepEqual(layers(still.backgroundSize), [
    `${major}px ${major}px`,
    `${GRID_STEP}px ${GRID_STEP}px`,
  ]);
  assert.deepEqual(layers(still.backgroundPosition), [
    `${-major / 2}px ${-major / 2}px`,
    `${-GRID_STEP / 2}px ${-GRID_STEP / 2}px`,
  ]);

  // Panned and zoomed, the crossings move and space out with the content.
  const moved = gridBackground({ scale: 2, tx: 30, ty: -10 });
  assert.equal(
    layers(moved.backgroundSize)[1],
    `${GRID_STEP * 2}px ${GRID_STEP * 2}px`,
  );
  assert.equal(
    layers(moved.backgroundPosition)[1],
    `${30 - GRID_STEP}px ${-10 - GRID_STEP}px`,
  );

  // Zoomed far out the minor dots would crowd into noise: only majors stay.
  const far = gridBackground({ scale: 0.25, tx: 0, ty: 0 });
  assert.equal(images(far.backgroundImage), 1);
});
