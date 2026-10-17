// `thread-open.ts` — the conversation asking to see a thread
// (`doric:comment-thread-open`). When it is one of this preview's, the frame
// comes into view and opens the root's thread. Every revision shows every
// thread, so the window keeps the revision on screen. Of the conversation's
// nodes only one answers: the node of the revision the target names, or — a
// target without a revision means the latest — the node of the preview's
// newest revision, which it asks the registry for, since a node's own
// reading may predate a later revision.

import type { Services } from 'bundle/contracts';
import { useEffect, useRef } from 'react';

import {
  ARTIFACT_TARGET_KIND,
  ArtifactsV1,
  COMMENT_THREAD_OPEN_EVENT,
  type CommentThreadOpenDetail,
  callScopeOf,
  type PreviewScope,
} from '../../contracts/index.js';

export interface ThreadOpenInput {
  readonly chrome: 'node' | 'canvas';
  readonly artifactId: string;
  /** The revision this frame stands for: the node's block, the window's on screen. */
  readonly ownRevision: number | undefined;
  /** How many revisions the record read knows of: the newest, when the registry cannot say. */
  readonly knownRevisions: number | undefined;
  readonly services: Services;
  readonly scope: PreviewScope | undefined;
  readonly showThread: (commentId: string) => void;
}

const answer = (input: ThreadOpenInput, detail: CommentThreadOpenDetail) => {
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
    if (input.scope === undefined) return input.knownRevisions;

    try {
      const latest = await input.services
        .use(ArtifactsV1, callScopeOf(input.scope))
        .read({ artifactId: input.artifactId });

      return latest?.revision ?? input.knownRevisions;
    } catch {
      return input.knownRevisions;
    }
  };

  void newest().then((latest) => {
    if (latest !== undefined && latest === input.ownRevision)
      input.showThread(detail.commentId);
  });
};

/** Listens for the conversation's requests for the frame's lifetime. */
export const useThreadOpenRequests = (input: ThreadOpenInput): void => {
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<CommentThreadOpenDetail>).detail;

      if (
        typeof detail?.commentId !== 'string' ||
        typeof detail.target?.id !== 'string'
      )
        return;

      answer(latest.current, detail);
    };

    document.addEventListener(COMMENT_THREAD_OPEN_EVENT, onOpen);

    return () =>
      document.removeEventListener(COMMENT_THREAD_OPEN_EVENT, onOpen);
  }, []);
};
