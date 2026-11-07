// FT29 (openui-diagrams-phase2.md F19; G3 a): `layoutSequence` on the
// sequence fixtures 3/12, 8/50 and 20/200, seeds 7919 × 1…5, sized with the
// estimate (7.8 px per character). Lifelines in participant order, plates
// between their lifelines, self-messages' plates beside their loops, no two
// plates or notes meeting, rows in step order, fragments holding everything
// inside them, and the whole drawing inside its size with the same margin on
// both sides. Time is not asserted.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Box, Point } from '../../src/client/diagram/layout-types.js';
import {
  DIAGRAM_METRICS,
  type Measure,
} from '../../src/client/diagram/measure.js';
import {
  layoutSequence,
  type SequenceLayout,
  type SequenceStepBox,
} from '../../src/client/diagram/sequence-layout.js';
import {
  readSequence,
  type SeqStep,
  type SequenceModel,
} from '../../src/client/diagram/sequence-model.js';
import { randomSequence } from './support/random-graph.js';

const FIXTURES = [
  { name: '3/12', participants: 3, steps: 12 },
  { name: '8/50', participants: 8, steps: 50 },
  { name: '20/200', participants: 20, steps: 200 },
] as const;

const SEEDS = [1, 2, 3, 4, 5].map((s) => 7919 * s);

/** Phase 1's estimate: characters × 7.8 px. */
const estimate: Measure = (text) => [...text].length * DIAGRAM_METRICS.estimate;

/** A model step with the participants it names and its descendants, in layout order. */
interface Flat {
  readonly step: SeqStep;
  /** Indexes into the flat list of every step inside a fragment. */
  readonly inside: number[];
}

/** The model's steps depth-first, a fragment before its sections' steps. */
const flatten = (steps: readonly SeqStep[], into: Flat[] = []): Flat[] => {
  for (const step of steps) {
    const entry: Flat = { step, inside: [] };
    into.push(entry);
    if (step.type === 'fragment') {
      const first = into.length;
      for (const section of step.sections) flatten(section.steps, into);
      for (let i = first; i < into.length; i += 1) entry.inside.push(i);
    }
  }
  return into;
};

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const EPSILON = 1e-6;

const holds = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x - EPSILON &&
  inner.y >= outer.y - EPSILON &&
  inner.x + inner.width <= outer.x + outer.width + EPSILON &&
  inner.y + inner.height <= outer.y + outer.height + EPSILON;

const holdsPoint = (outer: Box, point: Point): boolean =>
  holds(outer, { x: point.x, y: point.y, width: 0, height: 0 });

/** Every box and point a step box draws, for containment and bounds. */
const partsOf = (box: SequenceStepBox): { boxes: Box[]; points: Point[] } => {
  switch (box.type) {
    case 'message':
      return { boxes: [box.label], points: [...box.points] };
    case 'note':
      return { boxes: [box.box], points: [] };
    case 'fragment':
      return { boxes: [box.box, box.tab], points: [] };
  }
};

/** A step's top: the first y it takes. */
const topOf = (box: SequenceStepBox): number => {
  const { boxes, points } = partsOf(box);
  return Math.min(...boxes.map((b) => b.y), ...points.map((p) => p.y));
};

/** The participants a step names. */
const named = (step: SeqStep): string[] =>
  step.type === 'message'
    ? [step.from, step.to]
    : step.type === 'note'
      ? [...step.over]
      : [];

/** The problems of one layout, as F19's rules and FT29 state them. */
const problemsOf = (
  name: string,
  model: SequenceModel,
  layout: SequenceLayout,
): string[] => {
  const problems: string[] = [];
  const flat = flatten(model.steps);
  const index = new Map(model.participants.map((p, i) => [p.id, i]));
  const xOf = (id: string) => layout.columns[index.get(id) ?? -1]?.x ?? NaN;

  if (layout.columns.length !== model.participants.length) {
    problems.push(`${name}: ${layout.columns.length} columns`);
  }
  if (layout.steps.length !== flat.length) {
    problems.push(
      `${name}: ${layout.steps.length} step boxes for ${flat.length} steps`,
    );
    return problems;
  }

  // Lifelines in participant order; headers of one height.
  layout.columns.slice(1).forEach((column, i) => {
    if (!(column.x > (layout.columns[i]?.x ?? Infinity))) {
      problems.push(`${name}: lifeline ${i + 1} is not right of lifeline ${i}`);
    }
  });
  const heights = new Set(layout.columns.map((column) => column.header.height));
  if (heights.size > 1) problems.push(`${name}: headers of different heights`);

  // Plates between their lifelines, or beside their loop.
  layout.steps.forEach((box, i) => {
    const step = flat[i]?.step as SeqStep;
    if (box.type !== step.type) {
      problems.push(`${name}: step ${i} is a ${box.type}, not a ${step.type}`);
      return;
    }
    if (box.type !== 'message' || step.type !== 'message') return;
    const from = xOf(step.from);
    const to = xOf(step.to);
    const { label } = box;
    if (step.from !== step.to) {
      if (
        label.x < Math.min(from, to) - EPSILON ||
        label.x + label.width > Math.max(from, to) + EPSILON
      ) {
        problems.push(
          `${name}: plate of step ${i} is not between its lifelines`,
        );
      }
    } else {
      const loopRight = Math.max(...box.points.map((point) => point.x));
      const next = layout.columns[(index.get(step.from) ?? 0) + 1];
      if (label.x < loopRight - EPSILON) {
        problems.push(
          `${name}: plate of self-message ${i} is not right of its loop`,
        );
      }
      if (next !== undefined && label.x + label.width > next.x + EPSILON) {
        problems.push(
          `${name}: plate of self-message ${i} crosses the next lifeline`,
        );
      }
    }
  });

  // No two message plates or notes meet.
  const plates = layout.steps.flatMap((box, i) =>
    box.type === 'message'
      ? [{ i, box: box.label }]
      : box.type === 'note'
        ? [{ i, box: box.box }]
        : [],
  );
  plates.forEach((a, k) => {
    for (const b of plates.slice(k + 1)) {
      if (overlaps(a.box, b.box)) {
        problems.push(`${name}: steps ${a.i} and ${b.i} meet`);
      }
    }
  });

  // Rows in step order.
  layout.steps.slice(1).forEach((box, i) => {
    if (!(topOf(box) > topOf(layout.steps[i] as SequenceStepBox))) {
      problems.push(`${name}: step ${i + 1} does not start below step ${i}`);
    }
  });

  // Fragments hold everything inside them and span the lifelines it names.
  layout.steps.forEach((box, i) => {
    if (box.type !== 'fragment') return;
    const outer = box.box;
    if (!holds(outer, box.tab))
      problems.push(`${name}: fragment ${i} does not hold its tab`);
    for (const section of box.sections) {
      if (
        section.y < outer.y - EPSILON ||
        section.y + section.label.height > outer.y + outer.height + EPSILON
      ) {
        problems.push(`${name}: fragment ${i} does not hold a section label`);
      }
    }
    for (const j of flat[i]?.inside ?? []) {
      const { boxes, points } = partsOf(layout.steps[j] as SequenceStepBox);
      if (!boxes.every((inner) => holds(outer, inner))) {
        problems.push(
          `${name}: fragment ${i} does not hold the boxes of step ${j}`,
        );
      }
      if (!points.every((point) => holdsPoint(outer, point))) {
        problems.push(
          `${name}: fragment ${i} does not hold the points of step ${j}`,
        );
      }
      for (const id of named(flat[j]?.step as SeqStep)) {
        const x = xOf(id);
        if (x < outer.x - EPSILON || x > outer.x + outer.width + EPSILON) {
          problems.push(`${name}: fragment ${i} does not span lifeline ${id}`);
        }
      }
    }
  });

  // Everything within the size, with the same margin left and right.
  const boxes = [
    ...layout.columns.map((column) => column.header),
    ...layout.steps.flatMap((box) => partsOf(box).boxes),
  ];
  const points = layout.steps.flatMap((box) => partsOf(box).points);
  const inside = { x: 0, y: 0, width: layout.width, height: layout.height };
  if (!boxes.every((box) => holds(inside, box))) {
    problems.push(`${name}: a box lies outside 0…width, 0…height`);
  }
  if (!points.every((point) => holdsPoint(inside, point))) {
    problems.push(`${name}: a point lies outside 0…width, 0…height`);
  }
  const left = Math.min(
    ...boxes.map((box) => box.x),
    ...points.map((p) => p.x),
  );
  const right = Math.max(
    ...boxes.map((box) => box.x + box.width),
    ...points.map((p) => p.x),
  );
  if (!(left > 0) || Math.abs(left - (layout.width - right)) > EPSILON) {
    problems.push(
      `${name}: margins ${left} left and ${layout.width - right} right differ`,
    );
  }
  if (
    !(
      layout.top >= 0 &&
      layout.bottom <= layout.height &&
      layout.top < layout.bottom
    )
  ) {
    problems.push(`${name}: lifelines run outside the drawing`);
  }
  return problems;
};

for (const fixture of FIXTURES) {
  test(`FT29 ${fixture.name}: every seed meets F19's rules`, () => {
    const problems: string[] = [];
    for (const seed of SEEDS) {
      const model = readSequence(randomSequence(fixture, seed));
      assert.deepEqual(
        model.findings,
        [],
        `${fixture.name} seed ${seed} reads cleanly`,
      );
      problems.push(
        ...problemsOf(
          `${fixture.name} seed ${seed}`,
          model,
          layoutSequence(model, estimate),
        ),
      );
    }

    assert.deepEqual(problems, []);
  });
}

test('FT29: the same model laid out twice gives the same layout', () => {
  const model = readSequence(randomSequence(FIXTURES[1], SEEDS[0] as number));

  assert.deepEqual(
    layoutSequence(model, estimate),
    layoutSequence(model, estimate),
  );
});
