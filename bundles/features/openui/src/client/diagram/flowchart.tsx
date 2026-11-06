// The Flowchart renderer (openui-diagrams.md F4): its outline while the
// fence streams, then, once the fence is closed or unterminated, one layout
// per mount and drawn model, and the picture with the outline kept for
// screen readers.

import type { ComponentRenderProps } from '@openuidev/react-lang';
import { type ReactNode, useId } from 'react';

import { useFence } from '../question/fence-context.js';
import { DiagramCanvas } from './canvas.js';
import { toLayoutGraph } from './graph.js';
import { createMeasure, sizeModel } from './measure.js';
import { type FlowchartModel, readFlowchart } from './model.js';
import { flowchartOutline, Outline } from './outline.js';
import { NOTES, useDrawn } from './view.js';

/**
 * A Flowchart element's props as react-lang passes them: lists of element
 * nodes (or `null` while streaming), read only through `readFlowchart`.
 */
export interface FlowchartProps {
  readonly nodes?: unknown;
  readonly edges?: unknown;
  readonly groups?: unknown;
  readonly direction?: unknown;
  readonly height?: unknown;
}

/** The layout's key: the drawn parts and the direction, as JSON. */
const keyOf = ({ direction, nodes, edges, groups }: FlowchartModel): string =>
  JSON.stringify({ direction, nodes, edges, groups });

/** Every label of the model, for the faces measuring loads. */
const labelsOf = (model: FlowchartModel): string =>
  [...model.nodes, ...model.groups, ...model.edges]
    .map((part) => part.label ?? '')
    .join(' ');

/**
 * The Flowchart renderer (F4 state table): outline + note without a fence
 * context ("Diagrams are drawn only in the conversation."), while streaming
 * ("The diagram is drawn when its fence is complete."), while layout is
 * pending ("Drawing the diagram…") or on failure ("This diagram could not
 * be drawn: <message, first 200 characters>"); otherwise `DiagramCanvas`
 * with an sr-only outline. Lays out once per mount per drawn model; late
 * results are dropped. Never throws for any props.
 */
export function FlowchartView(
  props: ComponentRenderProps<FlowchartProps>,
): ReactNode {
  const fence = useFence();
  const outlineId = useId();
  const model = readFlowchart(props.props);
  const key = keyOf(model);
  const streaming = fence?.view.fence.state === 'streaming';
  const drawable = fence !== undefined && !streaming && model.nodes.length > 0;
  const layout = fence?.layout;
  const drawn = useDrawn(key, drawable && layout !== undefined, async () => {
    if (layout === undefined) throw new Error('no layout');
    const sizes = sizeModel(model, await createMeasure(labelsOf(model)));
    const result = await layout(toLayoutGraph(model, sizes));
    return { model, sizes, result };
  });

  const outline = (note?: string, hidden = false) => (
    <Outline
      text={flowchartOutline(model)}
      note={note}
      hidden={hidden}
      id={outlineId}
    />
  );

  if (fence === undefined) return outline(NOTES.noContext);
  if (streaming) return outline(NOTES.streaming);
  if (model.nodes.length === 0) return outline();
  if (drawn.state === 'pending') return outline(NOTES.pending);
  if (drawn.state === 'failed')
    return outline(`${NOTES.failed}${drawn.message}`);
  const current = drawn.value;
  return (
    <div className="flex w-full flex-col">
      <DiagramCanvas
        model={current.model}
        sizes={current.sizes}
        result={current.result}
        interactive={fence.interactive}
        outlineId={outlineId}
      />
      {outline(undefined, true)}
    </div>
  );
}
