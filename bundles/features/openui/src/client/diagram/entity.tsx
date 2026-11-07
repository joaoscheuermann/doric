// The EntityDiagram renderer (openui-diagrams-phase2.md F17): its outline
// while the fence streams, then, once the fence is closed or unterminated, one
// layout per mount and drawn model, and the picture with the outline kept for
// screen readers.

import type { ComponentRenderProps } from '@openuidev/react-lang';
import { type ReactNode, useId } from 'react';

import { useFence } from '../question/fence-context.js';
import { DiagramFrame } from './canvas.js';
import { type EntityModel, readEntities } from './entity-model.js';
import { EntityPicture } from './entity-picture.js';
import { entityGraph } from './graph.js';
import { createMeasure, sizeEntities } from './measure.js';
import { entityOutline, Outline } from './outline.js';
import { NOTES, useDrawn } from './view.js';

/** An EntityDiagram element's props; read only through `readEntities`. */
export interface EntityProps {
  readonly entities?: unknown;
  readonly relations?: unknown;
  readonly notation?: unknown;
  readonly direction?: unknown;
}

/** Every text the picture draws, for the faces measuring loads. */
const labelsOf = (model: EntityModel): string[] => [
  'PK FK UQ',
  ...model.entities.flatMap((entity) => [
    entity.name,
    ...entity.fields.flatMap((field) => [field.name, field.type ?? '']),
    ...entity.methods,
  ]),
  ...model.relations.flatMap((relation) => [
    relation.label ?? '',
    relation.fromCount ?? '',
    relation.toCount ?? '',
  ]),
];

/**
 * As `MindMapView`, with `entityOutline`, empty when no entity is kept, `sizeEntities` →
 * `entityGraph` → `layout`, `DiagramFrame` (`ER diagram, pan and zoom` or `Class diagram, pan
 * and zoom`) around `EntityPicture`. Never throws.
 */
export function EntityView(
  props: ComponentRenderProps<EntityProps>,
): ReactNode {
  const fence = useFence();
  const outlineId = useId();
  const model = readEntities(props.props);
  const { notation, direction, entities, relations } = model;
  const key = JSON.stringify({ notation, direction, entities, relations });
  const streaming = fence?.view.fence.state === 'streaming';
  const layout = fence?.layout;
  const empty = entities.length === 0;
  const drawable =
    fence !== undefined && !streaming && !empty && layout !== undefined;
  const drawn = useDrawn(key, drawable, async () => {
    if (layout === undefined) throw new Error('no layout');
    const measure = await createMeasure(labelsOf(model).join(' '));
    const sizes = sizeEntities(model, measure);
    const result = await layout(entityGraph(model, sizes));
    return { model, sizes, result };
  });

  const text = entityOutline(model);
  const outline = (note?: string, hidden = false) => (
    <Outline text={text} note={note} hidden={hidden} id={outlineId} />
  );

  if (fence === undefined) return outline(NOTES.noContext);
  if (streaming) return outline(NOTES.streaming);
  if (empty) return outline();
  if (drawn.state === 'pending') return outline(NOTES.pending);
  if (drawn.state === 'failed')
    return outline(`${NOTES.failed}${drawn.message}`);
  const current = drawn.value;
  return (
    <div className="flex w-full flex-col">
      <DiagramFrame
        content={current.result}
        interactive={fence.interactive}
        areaLabel={
          current.model.notation === 'class'
            ? 'Class diagram, pan and zoom'
            : 'ER diagram, pan and zoom'
        }
      >
        <EntityPicture
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
