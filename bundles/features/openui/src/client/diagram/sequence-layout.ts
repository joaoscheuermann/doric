// The sequence layout (openui-diagrams-phase2.md F19): a pure function of the
// renderer chunk; columns in participant order, rows in step order. Its constants
// (SEQUENCE_METRICS) are module-private.

import type { Box, Point } from './layout-types.js';
import {
  DIAGRAM_METRICS,
  type Measure,
  type TextBlock,
  wrapLabel,
} from './measure.js';
import type { SeqStep, SequenceModel } from './sequence-model.js';

export interface SequenceLayout {
  readonly width: number;
  readonly height: number;
  /** One per participant: its header box and its lifeline's x. */
  readonly columns: readonly {
    readonly header: Box;
    readonly x: number;
    readonly label: TextBlock;
  }[];
  /** Lifelines run from `top` to `bottom`. */
  readonly top: number;
  readonly bottom: number;
  /** One per drawn step, depth-first, in program order. */
  readonly steps: readonly SequenceStepBox[];
}
export type SequenceStepBox =
  | {
      readonly type: 'message';
      readonly points: readonly Point[];
      readonly label: Box;
      readonly text: TextBlock;
      readonly kind: 'call' | 'reply' | 'async';
    }
  | { readonly type: 'note'; readonly box: Box; readonly text: TextBlock }
  | {
      readonly type: 'fragment';
      readonly box: Box;
      /** The kind tab at the box's top left. */
      readonly tab: Box;
      readonly kind: string;
      /** Each section's label line; `y` is its top, where a separator is drawn after the first. */
      readonly sections: readonly {
        readonly y: number;
        readonly label: TextBlock;
      }[];
    };

/** F19's constants, in px. */
const SEQUENCE_METRICS = {
  /** Around the whole drawing. */
  margin: 16,
  /** Between two neighbouring headers. */
  gap: 40,
  /** From the headers' bottom to the first row. */
  headerGap: 16,
  /** Above and below each row's content. */
  rowPadding: 8,
  /** From a message's label plate down to its arrow. */
  arrowGap: 6,
  /** Between a lifeline and a label plate or note edge beside it. */
  side: 8,
  /** A self-message's loop. */
  selfWidth: 32,
  selfHeight: 20,
  /** A fragment's padding around its content and below its last section. */
  inset: 10,
  /** Around the text of a kind tab and of a section label line. */
  tabPadding: 4,
  /** Around a note's text. */
  notePadding: 8,
} as const;

type Message = Extract<SeqStep, { type: 'message' }>;

/** Placed step boxes, depth-first, and the end of their last band. */
interface Placed {
  readonly boxes: readonly SequenceStepBox[];
  readonly bottom: number;
}

/** The messages of `steps`, depth-first. */
const messagesOf = (steps: readonly SeqStep[]): Message[] =>
  steps.flatMap((step) =>
    step.type === 'message'
      ? [step]
      : step.type === 'note'
        ? []
        : step.sections.flatMap((section) => messagesOf(section.steps)),
  );

/** The leftmost and rightmost x a step box draws at. */
const extentOf = (box: SequenceStepBox): readonly [number, number] => {
  if (box.type !== 'message') return [box.box.x, box.box.x + box.box.width];
  const xs = box.points.map((point) => point.x);
  return [
    Math.min(box.label.x, ...xs),
    Math.max(box.label.x + box.label.width, ...xs),
  ];
};

const shiftBox = (box: Box, dx: number): Box => ({ ...box, x: box.x + dx });

const shiftStep = (box: SequenceStepBox, dx: number): SequenceStepBox => {
  switch (box.type) {
    case 'message':
      return {
        ...box,
        points: box.points.map((point) => ({ ...point, x: point.x + dx })),
        label: shiftBox(box.label, dx),
      };
    case 'note':
      return { ...box, box: shiftBox(box.box, dx) };
    case 'fragment':
      return { ...box, box: shiftBox(box.box, dx), tab: shiftBox(box.tab, dx) };
  }
};

/**
 * Places a sequence model by F19's rules 1–5 with `measure` (and `DIAGRAM_METRICS`): headers
 * (an empty label draws the id) of equal height at the margin; lifeline gaps that only grow to
 * fit each message's plate and each self-message's loop; one band per step, depth-first, so
 * steps in different bands never meet; each fragment's box holding everything inside it with
 * `inset` to spare; everything shifted so the leftmost edge is at the margin. `columns` has
 * one entry per `model.participants`, `steps` one per drawn step in the model's depth-first
 * order (a fragment before its sections' steps). A message's `points` run from its `from`
 * lifeline to its `to` lifeline (four points, a loop to the right, for a self-message). Same
 * input, same output. Pure; never throws; never loads the layout chunk.
 */
export const layoutSequence = (
  model: SequenceModel,
  measure: Measure,
): SequenceLayout => {
  const M = SEQUENCE_METRICS;
  const { lineHeight, nodePadding, edgeLabelPadding, maxWidth } =
    DIAGRAM_METRICS;
  const index = new Map(model.participants.map(({ id }, i) => [id, i]));
  const at = (id: string): number => index.get(id) ?? 0;
  const plate = (step: Message): TextBlock =>
    wrapLabel(step.text, maxWidth.edge, measure);

  // 1. Headers.
  const labels = model.participants.map(({ id, label }) =>
    wrapLabel(label === '' ? id : label, maxWidth.box, measure),
  );
  const widths = labels.map((label) => label.width + 2 * nodePadding);
  const headerHeight = Math.max(
    0,
    ...labels.map((label) => label.height + 2 * nodePadding),
  );

  // 2. Columns: gaps that only grow, messages by span, smallest first.
  const gaps = widths
    .slice(1)
    .map((width, i) => ((widths[i] ?? 0) + width) / 2 + M.gap);
  const span = (step: Message) => Math.abs(at(step.from) - at(step.to));
  const sum = (from: number, to: number) =>
    gaps.slice(from, to).reduce((total, gap) => total + gap, 0);
  for (const step of [...messagesOf(model.steps)].sort(
    (a, b) => span(a) - span(b),
  )) {
    const plateWidth = plate(step).width + 2 * edgeLabelPadding;
    const from = at(step.from);
    const to = at(step.to);
    if (from === to) {
      const need = M.selfWidth + M.side + plateWidth + M.side;
      if (from < gaps.length) gaps[from] = Math.max(gaps[from] ?? 0, need);
      continue;
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const short = plateWidth + 2 * M.side - sum(lo, hi);
    if (short > 0) gaps[hi - 1] = (gaps[hi - 1] ?? 0) + short;
  }
  const xs = widths.map((_, i) => sum(0, i));
  const xOf = (id: string): number => xs[at(id)] ?? 0;

  // 3 and 4. Rows, depth-first; a fragment's box from its placed contents.
  const tabHeight = lineHeight + 2 * M.tabPadding;

  /** The boxes of `steps` placed in bands from `top`, and the last band's end. */
  const placeAll = (steps: readonly SeqStep[], top: number): Placed =>
    steps.reduce<Placed>(
      (done, step) => {
        const next = place(step, done.bottom);
        return {
          boxes: [...done.boxes, ...next.boxes],
          bottom: next.bottom,
        };
      },
      { boxes: [], bottom: top },
    );

  const place = (step: SeqStep, top: number): Placed => {
    const y = top + M.rowPadding;
    switch (step.type) {
      case 'message': {
        const text = plate(step);
        const width = text.width + 2 * edgeLabelPadding;
        const height = text.height + 2 * edgeLabelPadding;
        const from = xOf(step.from);
        const to = xOf(step.to);
        if (step.from === step.to) {
          const right = from + M.selfWidth;
          const loop = y + M.selfHeight;
          return {
            boxes: [
              {
                type: 'message',
                points: [
                  { x: from, y },
                  { x: right, y },
                  { x: right, y: loop },
                  { x: from, y: loop },
                ],
                label: { x: right + M.side, y, width, height },
                text,
                kind: step.kind,
              },
            ],
            bottom: Math.max(loop, y + height) + M.rowPadding,
          };
        }
        const arrow = y + height + M.arrowGap;
        return {
          boxes: [
            {
              type: 'message',
              points: [
                { x: from, y: arrow },
                { x: to, y: arrow },
              ],
              label: { x: (from + to) / 2 - width / 2, y, width, height },
              text,
              kind: step.kind,
            },
          ],
          bottom: arrow + M.rowPadding,
        };
      }
      case 'note': {
        const text = wrapLabel(step.text, maxWidth.box, measure);
        const over = step.over.map(xOf);
        const lo = Math.min(...over);
        const hi = Math.max(...over);
        const width = Math.max(
          text.width + 2 * M.notePadding,
          hi - lo + 2 * M.side,
        );
        const height = text.height + 2 * M.notePadding;
        return {
          boxes: [
            {
              type: 'note',
              box: { x: (lo + hi) / 2 - width / 2, y, width, height },
              text,
            },
          ],
          bottom: y + height + M.rowPadding,
        };
      }
      case 'fragment': {
        const sections: { y: number; label: TextBlock }[] = [];
        const contents: SequenceStepBox[] = [];
        let end = top + tabHeight;
        for (const section of step.sections) {
          const text = section.label === '' ? '' : `[${section.label}]`;
          sections.push({
            y: end,
            label: {
              lines: text === '' ? [] : [text],
              width: text === '' ? 0 : measure(text),
              height: text === '' ? 0 : lineHeight,
            },
          });
          const placed = placeAll(section.steps, end + tabHeight);
          contents.push(...placed.boxes);
          end = placed.bottom;
        }
        const bottom = end + M.inset;
        const inner = contents.map(extentOf);
        const left = Math.min(...inner.map(([l]) => l)) - M.inset;
        const tabWidth = measure(step.kind) + 2 * M.tabPadding;
        const right = Math.max(
          ...inner.map(([, r]) => r + M.inset),
          left + tabWidth + M.inset,
          ...sections.map(({ label }) => left + label.width + 2 * M.inset),
        );
        const box: SequenceStepBox = {
          type: 'fragment',
          box: { x: left, y: top, width: right - left, height: bottom - top },
          tab: { x: left, y: top, width: tabWidth, height: tabHeight },
          kind: step.kind,
          sections,
        };
        return { boxes: [box, ...contents], bottom };
      }
    }
  };

  const top = M.margin + headerHeight;
  const { boxes: placed, bottom } = placeAll(model.steps, top + M.headerGap);

  // 5. Size: shift so the leftmost edge is at the margin.
  const extents = [
    ...xs.map((x, i): readonly [number, number] => [
      x - (widths[i] ?? 0) / 2,
      x + (widths[i] ?? 0) / 2,
    ]),
    ...placed.map(extentOf),
  ];
  const minX = extents.length === 0 ? 0 : Math.min(...extents.map(([l]) => l));
  const maxX =
    extents.length === 0 ? 0 : Math.max(...extents.map(([, r]) => r));
  const dx = M.margin - minX;

  return {
    width: maxX + dx + M.margin,
    height: bottom + M.margin,
    columns: labels.map((label, i) => {
      const x = (xs[i] ?? 0) + dx;
      const width = widths[i] ?? 0;
      return {
        header: { x: x - width / 2, y: M.margin, width, height: headerHeight },
        x,
        label,
      };
    }),
    top,
    bottom,
    steps: placed.map((box) => shiftStep(box, dx)),
  };
};
