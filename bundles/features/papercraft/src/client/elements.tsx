// The `papercraft` client elements (spec: "Composição e partes").
//
// One public Web Component, React-backed over the shared
// `desktop/ui/react-element` boundary, as the `threads` bundle publishes its
// delegated turn:
//
//   - `<papercraft-canvas>` — the `/papercraft/:projectId/:threadId/:identity`
//     route (D26): a papercraft program's surface full-screen, with
//     `chrome: 'canvas'` (tree left, command bar bottom-centre).
//
// It hands the surface the Project and Thread the program belongs to, from
// its path, so every host call is scoped and the comments join that Thread's
// stack. A comment's line in the composer stack is chat's own
// (`chat-comment-line`): the items name it, so this bundle defines no line
// element.
//
// The classes are made inside factories the activation calls, so importing
// this module touches no DOM global; every element extends `HTMLElement`.

import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';

import {
  PAPERCRAFT_CANVAS_TAG,
  type PreviewScope,
} from '../contracts/index.js';
import { PreviewContainer } from './surface/preview-container.js';

/**
 * The canvas window's surface for one route segment (D26): the papercraft
 * program of that identity in the scope's Thread; nothing without a Thread.
 */
function CanvasRoute({
  services,
  scope,
  segment,
}: {
  readonly services: Services;
  readonly scope: PreviewScope | undefined;
  readonly segment: string;
}) {
  if (scope?.threadId === undefined) return null;

  return (
    <PreviewContainer
      services={services}
      chrome="canvas"
      scope={scope}
      source={{ kind: 'program', threadId: scope.threadId, identity: segment }}
    />
  );
}

interface CanvasElementProps {
  readonly projectId?: string;
  readonly threadId?: string;
  /** The route's last segment (D26): a papercraft program's identity. */
  readonly identity?: string;
}

/** `<papercraft-canvas>`: the full-screen route of one program. */
export const defineCanvasElement = () => {
  const Base = defineReactElement<CanvasElementProps>({
    props: ['projectId', 'threadId', 'identity'],
    render: ({ projectId, threadId, identity, services }) => {
      if (identity === undefined || identity === '') return null;

      const scope: PreviewScope | undefined =
        projectId === undefined || projectId === ''
          ? undefined
          : {
              projectId,
              ...(threadId === undefined || threadId === ''
                ? {}
                : { threadId }),
            };

      return (
        <CanvasRoute services={services} scope={scope} segment={identity} />
      );
    },
  });

  return class PapercraftCanvasElement
    extends Base
    implements CanvasElementProps
  {
    declare projectId: string | undefined;
    declare threadId: string | undefined;
    declare identity: string | undefined;
  };
};

/** The tags this module's factories define, as the activation registers them. */
export const PAPERCRAFT_TAGS = [
  [PAPERCRAFT_CANVAS_TAG, defineCanvasElement],
] as const;

export type { Services };
