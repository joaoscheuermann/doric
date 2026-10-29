// `thread-open.ts` — the conversation asking to see a thread
// (`doric:comment-thread-open`). When it is one of this artifact's, the frame
// comes into view and opens the root's thread. Every revision shows every
// thread, so the window keeps the revision on screen. Of the conversation's
// nodes only one answers: the node of the revision the target names, or — a
// target without a revision means the latest — the node of the artifact's
// newest revision, which it asks the owner for, since a node's own reading may
// predate a later revision.

import { useEffect, useRef } from 'react';

export interface ThreadOpenInput {
  readonly chrome: 'node' | 'canvas';
  readonly artifactId: string;
  /** The revision this frame stands for: the node's block, the window's on screen. */
  readonly ownRevision: number | undefined;
  /** How many revisions the record read knows of: the newest, when the registry cannot say. */
  readonly knownRevisions: number | undefined;
  /** The artifact's newest revision, asked of the registry; may reject. */
  readonly latestRevision: () => Promise<number | undefined>;
  /** The DOM event the conversation asks with (`doric:comment-thread-open`). */
  readonly eventName: string;
  readonly showThread: (commentId: string) => void;
}

/* Internal, not exported: the detail read, structurally chat's `CommentThreadOpenDetail`. */
interface ThreadOpenDetail {
  readonly commentId: string;
  readonly target: {
    readonly kind: string;
    readonly id: string;
    readonly revision?: number;
  };
}

const ARTIFACT_TARGET_KIND = 'artifact';

const answer = (input: ThreadOpenInput, detail: ThreadOpenDetail) => {
  const revision = detail.target.revision;

  if (detail.target.kind !== ARTIFACT_TARGET_KIND) return;
  if (detail.target.id !== input.artifactId) return;

  if (input.chrome !== 'node') {
    input.showThread(detail.commentId);

    return;
  }

  if (revision !== undefined) {
    if (revision === input.ownRevision) input.showThread(detail.commentId);

    return;
  }

  const newest = async (): Promise<number | undefined> => {
    try {
      return (await input.latestRevision()) ?? input.knownRevisions;
    } catch {
      return input.knownRevisions;
    }
  };

  void newest().then((latest) => {
    if (latest !== undefined && latest === input.ownRevision)
      input.showThread(detail.commentId);
  });
};

/**
 * Listens on the document for `eventName` for the frame's lifetime, reading
 * the latest `input` on each event. Only a request whose target is of kind
 * `artifact` and names `artifactId` is answered. Outside the node, the
 * request shows its thread. In the node, a target with a revision is shown
 * only by the node of that revision, and one without a revision only by the
 * node of the newest revision — `latestRevision()`, or `knownRevisions` when
 * that rejects or answers undefined. A detail without a string `commentId` or
 * `target.id` is ignored.
 */
export const useThreadOpenRequests = (input: ThreadOpenInput): void => {
  const latest = useRef(input);
  latest.current = input;
  const eventName = input.eventName;

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<ThreadOpenDetail | undefined>)
        .detail;

      if (
        typeof detail?.commentId !== 'string' ||
        typeof detail.target?.id !== 'string'
      )
        return;

      answer(latest.current, detail);
    };

    document.addEventListener(eventName, onOpen);

    return () => document.removeEventListener(eventName, onOpen);
  }, [eventName]);
};
