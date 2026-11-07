// The SequenceDiagram renderer (openui-diagrams-phase2.md F17, F19): its
// outline while the fence streams, then, once the fence is closed or
// unterminated, its own layout in the renderer chunk (never the layout chunk),
// and the picture with the outline kept for screen readers.

import type { ComponentRenderProps } from '@openuidev/react-lang';
import { type ReactNode, useId } from 'react';

import { useFence } from '../question/fence-context.js';
import { DiagramFrame } from './canvas.js';
import { createMeasure } from './measure.js';
import { Outline, sequenceOutline } from './outline.js';
import { layoutSequence } from './sequence-layout.js';
import { readSequence, type SeqStep } from './sequence-model.js';
import { SequencePicture } from './sequence-picture.js';
import { NOTES, useDrawn } from './view.js';

/** A SequenceDiagram element's props; read only through `readSequence`. */
export interface SequenceProps {
  readonly participants?: unknown;
  readonly steps?: unknown;
}

/** Every text the steps draw, for the faces measuring loads. */
const textsOf = (steps: readonly SeqStep[]): string[] =>
  steps.flatMap((step) =>
    step.type === 'fragment'
      ? [
          step.kind,
          ...step.sections.flatMap((section) => [
            `[${section.label}]`,
            ...textsOf(section.steps),
          ]),
        ]
      : [step.text],
  );

/**
 * As `MindMapView`, with `sequenceOutline`, empty when no participant is kept, and
 * `layoutSequence(model, measure)` instead of a layout: it never reads the context's `layout`,
 * so it never loads the layout chunk (G5). `DiagramFrame` (`Sequence diagram, pan and zoom`)
 * around `SequencePicture`. Never throws.
 */
export function SequenceView(
  props: ComponentRenderProps<SequenceProps>,
): ReactNode {
  const fence = useFence();
  const outlineId = useId();
  const model = readSequence(props.props);
  const { participants, steps } = model;
  const key = JSON.stringify({ participants, steps });
  const streaming = fence?.view.fence.state === 'streaming';
  const drawable = fence !== undefined && !streaming && participants.length > 0;
  const drawn = useDrawn(key, drawable, async () => {
    const labels = [
      ...participants.map((participant) => participant.label),
      ...textsOf(steps),
    ];
    const layout = layoutSequence(model, await createMeasure(labels.join(' ')));
    return { model, layout };
  });

  const text = sequenceOutline(model);
  const outline = (note?: string, hidden = false) => (
    <Outline text={text} note={note} hidden={hidden} id={outlineId} />
  );

  if (fence === undefined) return outline(NOTES.noContext);
  if (streaming) return outline(NOTES.streaming);
  if (participants.length === 0) return outline();
  if (drawn.state === 'pending') return outline(NOTES.pending);
  if (drawn.state === 'failed')
    return outline(`${NOTES.failed}${drawn.message}`);
  const current = drawn.value;
  return (
    <div className="flex w-full flex-col">
      <DiagramFrame
        content={current.layout}
        interactive={fence.interactive}
        areaLabel="Sequence diagram, pan and zoom"
      >
        <SequencePicture
          model={current.model}
          layout={current.layout}
          outlineId={outlineId}
        />
      </DiagramFrame>
      {outline(undefined, true)}
    </div>
  );
}
