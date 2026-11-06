// The `papercraft` client elements (spec: "Composição e partes").
//
// Two public Web Components, both React-backed over the shared
// `desktop/ui/react-element` boundary, as the `threads` bundle publishes its
// delegated turn:
//
//   - `<papercraft-preview>` — the body of one preview revision inside the
//     `artifacts` registry's frame (the kind's `bodyTag`). The frame hands it
//     its block (`block`) and calls `comment(detail)` for its comment gesture;
//     it mounts the surface with `chrome: 'node'`.
//   - `<papercraft-canvas>` — the `/papercraft/:projectId/:threadId/:artifactId`
//     route: the same surface full-screen, with `chrome: 'canvas'` (tree left,
//     command bar bottom-centre, `Autorizar` only under the `request` policy).
//
// Both hand the frame the Project and Thread the preview belongs to — the
// node from its block (the event's own scope), the window from its path — so
// every host call is scoped and the comments join that Thread's stack. A
// comment's line in the composer stack is chat's own (`chat-comment-line`):
// the items name it, so this bundle defines no line element.
//
// The classes are made inside factories the activation calls, so importing
// this module touches no DOM global; every element extends `HTMLElement`.

import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import { useEffect, useMemo, useState } from 'react';

import {
  ArtifactsV1,
  callScopeOf,
  PAPERCRAFT_CANVAS_TAG,
  PAPERCRAFT_PREVIEW_TAG,
  type PreviewScope,
} from '../contracts/index.js';
import { previewBlockDataOf } from './block.js';
import { locationScope } from './comment.js';
import type { CanvasSource } from './surface/canvas-source.js';
import { PreviewContainer } from './surface/preview-container.js';

/** An artifact id as the old path wrote it in a canvas path: a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The canvas a route segment names (D26): a UUID naming an artifact of the
 * Thread opens that artifact's canvas, every other segment is a papercraft
 * identity; `undefined` while the artifact is being looked up.
 */
const useCanvasSource = (
  services: Services,
  scope: PreviewScope | undefined,
  segment: string,
): CanvasSource | undefined => {
  const program = useMemo<CanvasSource | undefined>(
    () =>
      scope?.threadId === undefined
        ? undefined
        : { kind: 'program', threadId: scope.threadId, identity: segment },
    [scope?.threadId, segment],
  );
  const [artifact, setArtifact] = useState<boolean | undefined>(
    UUID.test(segment) ? undefined : false,
  );
  const projectId = scope?.projectId;
  const threadId = scope?.threadId;

  useEffect(() => {
    if (!UUID.test(segment) || projectId === undefined) {
      setArtifact(false);

      return;
    }

    let live = true;
    setArtifact(undefined);
    services
      .use(
        ArtifactsV1,
        callScopeOf({
          projectId,
          ...(threadId === undefined ? {} : { threadId }),
        }),
      )
      .read({ artifactId: segment })
      .then(
        (record) => live && setArtifact(record !== undefined),
        () => live && setArtifact(false),
      );

    return () => {
      live = false;
    };
  }, [services, segment, projectId, threadId]);

  return artifact === undefined
    ? undefined
    : artifact
      ? { kind: 'artifact', artifactId: segment }
      : (program ?? { kind: 'artifact', artifactId: segment });
};

/** The canvas window's surface for one route segment. */
function CanvasRoute({
  services,
  scope,
  segment,
}: {
  readonly services: Services;
  readonly scope: PreviewScope | undefined;
  readonly segment: string;
}) {
  const source = useCanvasSource(services, scope, segment);

  if (source === undefined) return null;

  return (
    <PreviewContainer
      services={services}
      chrome="canvas"
      scope={scope}
      artifactId={source.kind === 'artifact' ? source.artifactId : segment}
      {...(source.kind === 'program' ? { source } : {})}
    />
  );
}

interface PreviewElementProps {
  readonly block?: unknown;
  /** Bumped by each comment gesture of the frame; the surface toggles comment mode. */
  readonly commentRequest?: number;
}

/** What the registry's frame passes `comment(detail)`. */
export interface FrameCommentDetail {
  readonly artifactId: string;
  readonly revision: number;
  readonly kind: string;
}

/** `<papercraft-preview>`: the body of one revision inside the registry's frame. */
export const definePreviewElement = () => {
  const Base = defineReactElement<PreviewElementProps>({
    props: ['block', 'commentRequest'],
    render: ({ block, commentRequest, services }) => {
      const data = previewBlockDataOf(block);

      if (data === undefined) return null;

      const scope: PreviewScope | undefined =
        data.projectId === undefined
          ? locationScope()
          : {
              projectId: data.projectId,
              ...(data.threadId === undefined
                ? {}
                : { threadId: data.threadId }),
            };

      return (
        <PreviewContainer
          services={services}
          chrome="node"
          scope={scope}
          artifactId={data.artifactId}
          blockRevision={data.revision}
          {...(commentRequest === undefined ? {} : { commentRequest })}
        />
      );
    },
  });

  return class PapercraftPreviewElement
    extends Base
    implements PreviewElementProps
  {
    declare block: unknown;
    declare commentRequest: number | undefined;

    /**
     * The frame's comment gesture: the comment is anchored here, in the
     * canvas, so it arms (or disarms) the comment tool of this revision.
     */
    comment(detail?: FrameCommentDetail): void {
      const data = previewBlockDataOf(this.block);

      if (
        detail !== undefined &&
        data !== undefined &&
        (detail.artifactId !== data.artifactId ||
          detail.revision !== data.revision)
      ) {
        return;
      }

      this.commentRequest = (this.commentRequest ?? 0) + 1;
    }
  };
};

interface CanvasElementProps {
  readonly projectId?: string;
  readonly threadId?: string;
  /** The route's last segment (D26): an artifact id or a papercraft identity. */
  readonly identity?: string;
  /** The old path's name of the segment. */
  readonly artifactId?: string;
}

/** `<papercraft-canvas>`: the full-screen route of one preview. */
export const defineCanvasElement = () => {
  const Base = defineReactElement<CanvasElementProps>({
    props: ['projectId', 'threadId', 'identity', 'artifactId'],
    render: ({ projectId, threadId, identity, artifactId, services }) => {
      const segment = identity ?? artifactId;

      if (segment === undefined || segment === '') return null;

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
        <CanvasRoute services={services} scope={scope} segment={segment} />
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
    declare artifactId: string | undefined;
  };
};

/** The tags this module's factories define, as the activation registers them. */
export const PAPERCRAFT_TAGS = [
  [PAPERCRAFT_PREVIEW_TAG, definePreviewElement],
  [PAPERCRAFT_CANVAS_TAG, defineCanvasElement],
] as const;

export type { Services };
