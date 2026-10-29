// The conversation node of one diagram revision (spec "O node mostra a
// revisão"): its data and its canvas.

import type { Services } from 'bundle/contracts';
import { type ReactElement, useCallback, useState } from 'react';

import type { DiagramScope } from '../contracts/index.js';
import { useDiagramData } from './diagram-data.js';
import { DiagramModal } from './diagram-modal.js';
import { DiagramCanvas } from './diagram-view.js';
import type { DiagramDrawing } from './drawing.js';
import type { DiagramBlockData } from './elements.js';

/** What `DiagramNode` draws one revision with. */
export interface DiagramNodeProps {
  readonly services: Services;
  /** Every host call's scope; undefined reads nothing. */
  readonly scope: DiagramScope | undefined;
  readonly block: DiagramBlockData;
  readonly drawing: DiagramDrawing;
  /** Bumped by the frame's comment gesture; each change toggles the comment tool. */
  readonly commentRequest?: number;
}

/**
 * The node: `useDiagramData` for the block's first page,
 * `DiagramCanvas host="node"`, and its modal. The modal state is
 * `'closed' | 'open' | 'closing'`: Expandir opens it (enabled once the
 * revision was read and drawn: `model`, `entry`, no `failure`; no Thread
 * required); a close request moves `open` to `closing`; `closing` becomes
 * `closed` when the focus is back in the node. The node stays active while
 * not `closed`. The modal opens on `block.revision`, page 1.
 */
export function DiagramNode({
  services,
  scope,
  block,
  drawing,
  commentRequest,
}: DiagramNodeProps): ReactElement {
  const data = useDiagramData({ services, scope, block, drawing });
  const [modal, setModal] = useState<'closed' | 'open' | 'closing'>('closed');
  const [focused, setFocused] = useState(false);
  if (modal === 'closing' && focused) setModal('closed');

  const expand = useCallback(() => setModal('open'), []);
  const collapse = useCallback(
    () => setModal((current) => (current === 'open' ? 'closing' : current)),
    [],
  );

  return (
    <>
      <DiagramCanvas
        host="node"
        services={services}
        scope={scope}
        block={block}
        data={data}
        {...(commentRequest === undefined ? {} : { commentRequest })}
        expand={{
          canExpand:
            data.model !== undefined &&
            data.entry !== undefined &&
            data.failure === undefined,
          held: modal !== 'closed',
          onExpand: expand,
        }}
        onFocusChange={setFocused}
      />
      <DiagramModal
        open={modal === 'open'}
        services={services}
        scope={scope}
        block={block}
        drawing={drawing}
        onCloseRequest={collapse}
      />
    </>
  );
}
