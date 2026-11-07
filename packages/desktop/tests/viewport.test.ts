// The viewport math of pan and zoom surfaces (`desktop/ui/viewport`, moved
// from papercraft's `surface/viewport.ts`, openui-diagrams.md F9): pan and
// zoom are one transform, every zoom keeps the pointer stable, the fit fits
// the content and the reading is whole percents; content with no area has
// nothing to fit yet. The wheel rule is a pure decision: a plain wheel is the
// page's until the surface captures it, and a modifier always zooms.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fitViewport,
  IDENTITY,
  toContent,
  type Viewport,
  viewportTransform,
  type WheelGestureInput,
  wheelGesture,
  zoomAt,
  zoomPercent,
} from '../src/viewport.js';

test('identity reads 100% and transforms to nothing', () => {
  assert.equal(zoomPercent(IDENTITY), '100%');
  assert.equal(viewportTransform(IDENTITY), 'translate(0px, 0px) scale(1)');
});

test('zooming keeps the pointer stable', () => {
  const viewport: Viewport = { scale: 1, tx: 40, ty: 20 };
  const origin = { x: 100, y: 60 };
  const zoomed = zoomAt(viewport, 2, origin);

  // What was at (100, 60) before is still there: content point (60, 40).
  assert.equal(zoomed.tx + 60 * zoomed.scale, origin.x);
  assert.equal(zoomed.ty + 40 * zoomed.scale, origin.y);
  assert.equal(zoomPercent(zoomed), '200%');
});

test('zoom is clamped, both ways', () => {
  assert.equal(zoomAt(IDENTITY, 100).scale, 4);
  assert.equal(zoomAt(IDENTITY, 0.01).scale, 0.25);
});

test('ajustar fits the content into the area, centred, clamped', () => {
  const fitted = fitViewport(
    { x: 100, y: 50, width: 800, height: 600 },
    { width: 400, height: 300 },
    24,
  );

  assert.ok(fitted !== undefined);
  assert.equal(fitted.scale, 0.42);
  // Centred: the content's box sits with equal margins on the x axis.
  assert.ok(Math.abs(fitted.tx + 100 * fitted.scale - 32) < 1e-9);

  // A tiny artifact would blow up: ajustar is a fit, not a magnifier, so it
  // never goes above identity.
  assert.equal(
    fitViewport(
      { x: 0, y: 0, width: 10, height: 10 },
      { width: 400, height: 300 },
    )?.scale,
    1,
  );

  // A huge artifact still stops at the lower limit every zoom has.
  assert.equal(
    fitViewport(
      { x: 0, y: 0, width: 100_000, height: 100_000 },
      { width: 400, height: 300 },
    )?.scale,
    0.25,
  );

  // Nothing to fit into: identity.
  assert.equal(
    fitViewport(
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 0, height: 0 },
    )?.scale,
    1,
  );
});

test('ajustar has nothing to fit while the content has no area', () => {
  // A module whose React root has not rendered yet measures as an empty box:
  // fitting it would settle on identity and never centre the element.
  for (const content of [
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 0, y: 0, width: 640, height: 0 },
  ]) {
    assert.equal(fitViewport(content, { width: 400, height: 300 }), undefined);
  }
});

test('a surface point becomes the content point under any pan/zoom', () => {
  const viewport: Viewport = { scale: 2, tx: 100, ty: -40 };

  assert.deepEqual(toContent(viewport, { x: 300, y: 60 }), { x: 100, y: 50 });
  assert.deepEqual(toContent(IDENTITY, { x: 5, y: 6 }), { x: 5, y: 6 });
});

const wheel = (input: Partial<WheelGestureInput>): WheelGestureInput => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  zoom: false,
  captured: false,
  pageHeight: 600,
  ...input,
});

test("a plain wheel over a surface that has not captured it is the page's", () => {
  assert.equal(wheelGesture(wheel({ deltaX: 12, deltaY: 30 })), undefined);
  assert.equal(
    wheelGesture(wheel({ deltaY: -40, deltaMode: 1, pageHeight: 0 })),
    undefined,
  );
});

test('a wheel with the zoom modifier zooms by 1.1 by the sign of deltaY, captured or not', () => {
  for (const captured of [false, true]) {
    assert.deepEqual(
      wheelGesture(wheel({ zoom: true, captured, deltaY: -40 })),
      {
        kind: 'zoom',
        factor: 1.1,
      },
    );
    assert.deepEqual(
      wheelGesture(wheel({ zoom: true, captured, deltaY: 40 })),
      {
        kind: 'zoom',
        factor: 1 / 1.1,
      },
    );
  }
});

test('a captured plain wheel pans against its deltas, scaled by its delta mode', () => {
  const cases = [
    { deltaMode: 0, scale: 1 },
    { deltaMode: 1, scale: 16 },
    { deltaMode: 2, scale: 600 },
  ];
  for (const { deltaMode, scale } of cases) {
    assert.deepEqual(
      wheelGesture(
        wheel({
          captured: true,
          deltaX: 3,
          deltaY: -5,
          deltaMode,
          pageHeight: 600,
        }),
      ),
      { kind: 'pan', dx: -3 * scale, dy: 5 * scale },
      `deltaMode ${deltaMode}`,
    );
  }
});

test('a page of a surface with no height pans by 800 px', () => {
  assert.deepEqual(
    wheelGesture(
      wheel({
        captured: true,
        deltaX: 1,
        deltaY: 2,
        deltaMode: 2,
        pageHeight: 0,
      }),
    ),
    { kind: 'pan', dx: -800, dy: -1600 },
  );
});
