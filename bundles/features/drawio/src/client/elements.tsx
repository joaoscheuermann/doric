// `<drawio-diagram>` (spec "O node mostra a revisão"): the `diagram` kind's
// body inside the `artifacts` registry's frame, React over the shared
// `desktop/ui/react-element` boundary, as Papercraft's `<papercraft-preview>`.
// The frame creates it with `ui/v1.create(DIAGRAM_BODY_TAG, { block })`,
// `block.type` set to DIAGRAM_BLOCK_TYPE and `block.data` the frame's
// `ArtifactFrameData`, and calls `comment(detail)` for its comment gesture.
// The kind declares `header: 'body'`, so the body draws its own header.
//
// The class is made inside a factory the activation calls, so importing this
// module touches no DOM global.

import {
  defineReactElement,
  type ReactElementInstance,
} from 'desktop/ui/react-element';

import { DIAGRAM_ENTRY, type DiagramScope } from '../contracts/index.js';
import { locationScope } from './comment.js';
import { DiagramNode } from './diagram-node.js';
import { type DiagramDrawing, defaultDrawing } from './drawing.js';

/**
 * What the body reads of the frame's block (`artifacts` ArtifactFrameData,
 * `block.data`): which revision it draws, the scope its host calls carry,
 * and the hash the drawing is keyed and checked by.
 */
export interface DiagramBlockData {
  /** The Project and Thread whose log holds the revision; non-empty when present. */
  readonly projectId?: string;
  readonly threadId?: string;
  /** Non-empty. */
  readonly artifactId: string;
  /** A positive integer. */
  readonly revision: number;
  /** The frame's title; the artifact id when the block has none. */
  readonly title: string;
  /** The note the revision was published with, when it has one. */
  readonly changeNote?: string;
  /**
   * The SHA-256 of the revision's DIAGRAM_ENTRY: the `sha256` of the
   * `block.data.entries` item whose `path` is DIAGRAM_ENTRY (the
   * `artifacts.created/v1` / `artifacts.revised/v1` payload's entries, which
   * the artifacts reducer keeps). Absent when no such entry names a string
   * hash.
   */
  readonly sha256?: string;
}

/** `value` as a record of its own keys, or undefined when it is not an object. */
const recordOf = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/**
 * Reads the diagram data off the block the frame hands the body: undefined
 * when `block.data` is not an object, its `artifactId` is not a non-empty
 * string, or its `revision` is not a positive integer. Every other field is
 * kept only when well-typed (empty `projectId` / `threadId` are dropped).
 * Pure; never throws.
 */
export const diagramBlockDataOf: (
  block: unknown,
) => DiagramBlockData | undefined = (block) => {
  const data = recordOf(recordOf(block)?.data);

  if (
    data === undefined ||
    typeof data.artifactId !== 'string' ||
    data.artifactId === '' ||
    typeof data.revision !== 'number' ||
    !Number.isInteger(data.revision) ||
    data.revision <= 0
  ) {
    return undefined;
  }

  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  const projectId = nonEmpty(data.projectId);
  const threadId = nonEmpty(data.threadId);
  const changeNote = nonEmpty(data.changeNote);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const sha256 = entries
    .map(recordOf)
    .find((entry) => entry?.path === DIAGRAM_ENTRY)?.sha256;

  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(threadId === undefined ? {} : { threadId }),
    artifactId: data.artifactId,
    revision: data.revision,
    title: nonEmpty(data.title) ?? data.artifactId,
    ...(changeNote === undefined ? {} : { changeNote }),
    ...(typeof sha256 === 'string' ? { sha256 } : {}),
  };
};

/** What the registry's frame passes `comment(detail)` (its ArtifactCommentDetail). */
export interface FrameCommentDetail {
  readonly artifactId: string;
  readonly revision: number;
  readonly kind: string;
}

/** The element `defineDiagramElement` makes: the React element plus the frame's seams. */
export interface DiagramElement extends ReactElementInstance {
  /** The frame's block; setting it re-renders. */
  block: unknown;
  /** Bumped by each `comment()`; the node toggles its comment tool on each change. */
  commentRequest: number | undefined;
  /**
   * The frame's comment gesture: arms (or disarms) this node's comment tool.
   * A detail naming another artifact or revision than the block's is
   * ignored; no detail, or a block not read yet, bumps the request.
   * Never throws.
   */
  comment(detail?: FrameCommentDetail): void;
}

/** The properties the element renders from. */
interface DiagramElementProps {
  readonly block?: unknown;
  readonly commentRequest?: number;
}

/**
 * The `<drawio-diagram>` class (register it with `ui/v1.define(
 * DIAGRAM_BODY_TAG, …)`). It renders nothing while `diagramBlockDataOf(block)`
 * is undefined; otherwise `DiagramNode` (`diagram-node.tsx`: the node's data
 * and its `DiagramCanvas`) with the block's scope — `{ projectId, threadId?
 * }` from the block, else `locationScope()` — and `drawing` (default
 * `defaultDrawing`, the window's renderer and measurer; tests pass fakes).
 * Each call makes a new class.
 */
export const defineDiagramElement: (
  drawing?: DiagramDrawing,
) => new () => DiagramElement = (drawing = defaultDrawing) => {
  const Base = defineReactElement<DiagramElementProps>({
    props: ['block', 'commentRequest'],
    render: ({ block, commentRequest, services }) => {
      const data = diagramBlockDataOf(block);

      if (data === undefined) return null;

      const scope: DiagramScope | undefined =
        data.projectId === undefined
          ? locationScope()
          : {
              projectId: data.projectId,
              ...(data.threadId === undefined
                ? {}
                : { threadId: data.threadId }),
            };

      return (
        <DiagramNode
          services={services}
          scope={scope}
          block={data}
          drawing={drawing}
          {...(commentRequest === undefined ? {} : { commentRequest })}
        />
      );
    },
  });

  return class DrawioDiagramElement extends Base implements DiagramElement {
    declare block: unknown;
    declare commentRequest: number | undefined;

    comment(detail?: FrameCommentDetail): void {
      const data = diagramBlockDataOf(this.block);

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
