// The MindMap renderer (openui-diagrams-phase2.md F17): its outline while the
// fence streams, then, once the fence is closed or unterminated, one layout
// per mount and drawn model, and the picture with the outline kept for
// screen readers.

import type { ComponentRenderProps } from '@openuidev/react-lang';
import { type ReactNode, useId } from 'react';

import { useFence } from '../question/fence-context.js';
import { DiagramFrame } from './canvas.js';
import { mindMapGraph } from './graph.js';
import { createMeasure, sizeMindMap } from './measure.js';
import { type MindTopic, readMindMap } from './mindmap-model.js';
import { MindMapPicture } from './mindmap-picture.js';
import { mindMapOutline, Outline } from './outline.js';
import { NOTES, useDrawn } from './view.js';

/** A MindMap element's props as react-lang passes them; read only through `readMindMap`. */
export interface MindMapProps {
  readonly root?: unknown;
  readonly layout?: unknown;
  readonly height?: unknown;
}

/** Every label of a topic and its subtopics, for the faces measuring loads. */
const labelsOf = (topic: MindTopic): string[] => [
  topic.label,
  ...topic.children.flatMap(labelsOf),
];

/**
 * Phase 1's state table (F4) with `mindMapOutline`: outline + `NOTES.noContext` without a fence
 * context, `NOTES.streaming` while streaming, the outline alone when there is no root,
 * `NOTES.pending` / `NOTES.failed + message` while laying out or on failure; otherwise
 * `DiagramFrame` (`Mind map, pan and zoom` or `Tree, pan and zoom`) around `MindMapPicture`,
 * with an sr-only outline. `sizeMindMap` → `mindMapGraph` → the context's `layout`, once per
 * mount per key (the model's JSON without `height`, `findings`, `cut`). Never throws.
 */
export function MindMapView(
  props: ComponentRenderProps<MindMapProps>,
): ReactNode {
  const fence = useFence();
  const outlineId = useId();
  const model = readMindMap(props.props);
  const { layout: direction, root, count } = model;
  const key = JSON.stringify({ layout: direction, root, count });
  const streaming = fence?.view.fence.state === 'streaming';
  const layout = fence?.layout;
  const drawable =
    fence !== undefined &&
    !streaming &&
    root !== undefined &&
    layout !== undefined;
  const drawn = useDrawn(key, drawable, async () => {
    if (layout === undefined) throw new Error('no layout');
    const labels = root === undefined ? [] : labelsOf(root);
    const sizes = sizeMindMap(model, await createMeasure(labels.join(' ')));
    const result = await layout(mindMapGraph(model, sizes));
    return { model, sizes, result };
  });

  const text = mindMapOutline(model);
  const outline = (note?: string, hidden = false) => (
    <Outline text={text} note={note} hidden={hidden} id={outlineId} />
  );

  if (fence === undefined) return outline(NOTES.noContext);
  if (streaming) return outline(NOTES.streaming);
  if (root === undefined) return outline();
  if (drawn.state === 'pending') return outline(NOTES.pending);
  if (drawn.state === 'failed')
    return outline(`${NOTES.failed}${drawn.message}`);
  const current = drawn.value;
  return (
    <div className="flex w-full flex-col">
      <DiagramFrame
        content={current.result}
        writtenHeight={current.model.height}
        interactive={fence.interactive}
        areaLabel={
          current.model.layout === 'down'
            ? 'Tree, pan and zoom'
            : 'Mind map, pan and zoom'
        }
      >
        <MindMapPicture
          model={current.model}
          sizes={current.sizes}
          result={current.result}
          outlineId={outlineId}
        />
      </DiagramFrame>
      {outline(undefined, true)}
    </div>
  );
}
