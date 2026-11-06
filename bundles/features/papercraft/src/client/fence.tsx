// `<papercraft-fence>` (D6, D14, D16, D19): the element chat creates for each
// `papercraft` fence while the Generative UI setting is on. It finds the
// fence's revision in the window's fold of the Thread's papercraft fences and
// draws it as a canvas node (`PreviewContainer`, `chrome: 'node'`) over the
// program's identity: the library bound at the fence's turn, its `Export`s,
// a protocol-2 frame (the window's warm one when there is one), the reported
// errors and the program's comments.

import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import { useEffect, useMemo, useState } from 'react';

import type { ChatFenceView } from '../contracts/chat.js';
import { PAPERCRAFT_TAG, programFolds } from './folds.js';
import type { CanvasSource } from './surface/canvas-source.js';
import { PreviewContainer } from './surface/preview-container.js';

/** The element chat mounts for a `papercraft` fence. */
export const FENCE_TAG = 'papercraft-fence';

/** The fence tag the element draws. */
export const PAPERCRAFT_FENCE = PAPERCRAFT_TAG;

const isView = (value: unknown): value is ChatFenceView =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { fence?: { key?: unknown } }).fence?.key === 'string' &&
  Array.isArray((value as { fences?: unknown }).fences);

/** What `<papercraft-fence>` draws for its `view`. */
function Fence({
  view,
  services,
}: {
  readonly view: ChatFenceView;
  readonly services: Services;
}) {
  const { fence, fences } = view;
  const threadId = fence.threadId;
  const [hold, setHold] = useState(() =>
    programFolds.hold(threadId, PAPERCRAFT_TAG),
  );

  useEffect(() => {
    const held = programFolds.hold(threadId, PAPERCRAFT_TAG);
    setHold(held);

    return () => held.release();
  }, [threadId]);
  useEffect(() => () => hold.release(), [hold]);

  const revision = useMemo(
    () => hold.fold.revisions(fences).get(fence.key),
    [hold, fences, fence.key],
  );
  const identity = revision?.identity;
  const source = useMemo<CanvasSource | undefined>(
    () =>
      identity === undefined
        ? undefined
        : { kind: 'program', threadId, identity },
    [identity, threadId],
  );
  const scope = useMemo(
    () => ({ projectId: fence.projectId, threadId }),
    [fence.projectId, threadId],
  );

  // D4: a fence with no completed line that is not blank has no revision.
  if (source === undefined) {
    return (
      <div className="flex flex-col gap-1">
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-xs">
          {fence.body}
        </pre>
        <p className="text-xs text-muted-foreground">
          {fence.state === 'unterminated'
            ? 'Incomplete: the answer ended before the fence closed'
            : 'Writing…'}
        </p>
      </div>
    );
  }

  return (
    <PreviewContainer
      services={services}
      chrome="node"
      scope={scope}
      source={source}
      fences={fences}
      fenceKey={fence.key}
    />
  );
}

interface ElementProps {
  readonly view?: unknown;
}

/** The `papercraft-fence` element class; chat sets `view`. */
export const defineFenceElement = () => {
  const Base = defineReactElement<ElementProps>({
    props: ['view'],
    render: ({ view, services }) =>
      isView(view) ? <Fence view={view} services={services} /> : null,
  });

  return class PapercraftFenceElement extends Base implements ElementProps {
    declare view: unknown;
  };
};
