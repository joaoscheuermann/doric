// `preview-data.ts` — what one frame reads of a preview's durable state and of
// its drafts (spec: "De onde vêm os dados").
//
// Every host call carries the preview's scope: the Project the host's lease
// needs and the Thread the preview belongs to. A frame without a Project scope
// reads nothing — an unscoped call would only be refused.
//
//   - the record of the revision on screen and the review policy, through
//     `artifacts/v1`; the markup, through `papercraft.previews/v1`;
//   - the durable comments of the preview — on every revision, so a thread
//     carries over to the next one — through `comments/v1.list` — the pins
//     that stay after the send flushed the drafts — and, once it answers,
//     through the Thread's log (`thread-log.ts`, shared by every frame of the
//     Thread): who answered, what was resolved and the prompt each comment
//     was written under, grouped into threads;
//   - the drafts of the preview in the Thread's composer stack, through
//     `chat.composer/v1.watch` — re-bound whenever chat's composer activates,
//     even after the frame rendered;
//   - before a revision's compiled module is imported (path B), its entries
//     through `artifacts/v1.read` (with their bytes), handed to the desktop's
//     verified cache `artifacts.cache/v1.ensure` — desktopMain resolves no
//     host contract, so the window carries the bytes across;
//   - in the window, the Thread's log through `runtime.threads/v1.watchThread`,
//     filtered by `artifacts.*` and `comments.*` with the same reducer the
//     chat's projector runs: a new revision, an approval or a flushed comment
//     shows up without reopening the window.
//
// None of this is application state: each reading is reconstructed from the
// services, and the view state of the canvas stays in the frame.

import type { Services } from 'bundle/contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import type { ComposerItem } from '../../contracts/chat.js';
import {
  ARTIFACT_TARGET_KIND,
  type ArtifactCacheEntry,
  type ArtifactRecord,
  ArtifactsCacheV1,
  ArtifactsV1,
  type Comment,
  CommentsV1,
  callScopeOf,
  PapercraftPreviewsV1,
  type PreviewScope,
  type PreviewState,
  RuntimeThreadsV1,
  type ThreadLogEvent,
} from '../../contracts/index.js';
import {
  composerAvailable,
  composerFor,
  draftOfItem,
  type PreviewDraft,
  subscribeComposer,
} from '../comment.js';
import {
  applyPreviewEvent,
  commentsOfEvents,
  initialPreviewStates,
  type PreviewComment,
  type PreviewStates,
  type PreviewThread,
  threadsOf,
} from '../domain/preview-state.js';
import { MODULE_ENTRY } from './preview-surface.js';
import { watchThreadComments } from './thread-log.js';

export type { PreviewDraft };

/** A comment `comments/v1.list` answered, in the reducer's shape. */
const commentOfList = (comment: Comment): PreviewComment => {
  const promptId = (comment as { readonly promptId?: unknown }).promptId;

  return {
    commentId: comment.commentId,
    text: comment.text,
    ...(comment.author === undefined ? {} : { author: comment.author }),
    ...(comment.target.revision === undefined
      ? {}
      : { revision: comment.target.revision }),
    anchor: comment.target.anchor,
    ...(comment.createdAt === '' ? {} : { createdAt: comment.createdAt }),
    ...(comment.inReplyTo === undefined
      ? {}
      : { inReplyTo: comment.inReplyTo }),
    resolved: comment.resolved,
    ...(typeof promptId === 'string' && promptId !== '' ? { promptId } : {}),
  };
};

export interface PreviewData {
  readonly record: ArtifactRecord | undefined;
  readonly policy: 'proceed' | 'request';
  readonly preview: PreviewState | undefined;
  readonly selectedRevision: number | undefined;
  readonly selectRevision: (revision: number) => void;
  /** Rereads the record, the policy and the comments. */
  readonly reload: () => void;
  /**
   * The durable threads of the preview, whatever revision each was written
   * on — each root with its replies and its state — in the order of the log.
   */
  readonly threads: readonly PreviewThread[];
  /** The drafts of the preview, roots and replies, in stack order. */
  readonly drafts: readonly PreviewDraft[];
  /** Rereads the durable comments (after a resolve, say). */
  readonly reloadComments: () => void;
  /** Whether a commented click has a stack to join. */
  readonly canComment: boolean;
  /** Whether the revision on screen is approved. */
  readonly approved: boolean;
}

export interface PreviewDataInput {
  readonly services: Services;
  readonly chrome: 'node' | 'canvas';
  readonly scope: PreviewScope | undefined;
  readonly artifactId: string;
  /** The node's revision; the window opens at the newest. */
  readonly blockRevision?: number;
}

const ARTIFACT_EVENT = /^artifacts\./;
const COMMENT_EVENT = /^comments\./;

/** Whether one log event names the artifact a frame shows. */
const namesArtifact = (event: ThreadLogEvent, artifactId: string): boolean => {
  const payload = event.event as
    | { readonly artifactId?: unknown; readonly target?: { id?: unknown } }
    | undefined;

  return (
    payload?.artifactId === artifactId || payload?.target?.id === artifactId
  );
};

/**
 * Writes one revision's entries into the desktop's verified cache, so
 * `doric://app/artifacts/<artifactId>@<revision>/…` serves them: the bytes come
 * from the host's `artifacts/v1.read` and `artifacts.cache/v1.ensure` writes
 * each one only once its SHA-256 matches. Rejects when the frame has no
 * Project scope, the revision is gone, its module's bytes are not served, or
 * the cache refused the module — the surface then shows the markup.
 */
export const ensureRevisionCached = async (
  services: Services,
  scope: PreviewScope | undefined,
  artifactId: string,
  revision: number,
): Promise<void> => {
  if (scope === undefined) {
    throw new Error('a preview without a Project scope reads nothing');
  }

  const call = callScopeOf(scope);
  const read = await services
    .use(ArtifactsV1, call)
    .read({ artifactId, revision });

  if (read === undefined) {
    throw new Error(`${artifactId}@${String(revision)} does not exist`);
  }

  const entries: ArtifactCacheEntry[] = read.entries.flatMap((entry) =>
    entry.base64 === undefined
      ? []
      : [{ path: entry.path, sha256: entry.sha256, base64: entry.base64 }],
  );

  if (!entries.some((entry) => entry.path === MODULE_ENTRY)) {
    throw new Error(`${artifactId}@${String(revision)} serves no module bytes`);
  }

  const result = await services
    .use(ArtifactsCacheV1, call)
    .ensure({ artifactId, revision, entries });
  const refused = result.failed.find((entry) => entry.path === MODULE_ENTRY);

  if (refused !== undefined) {
    throw new Error(`the cache refused the module: ${refused.message}`);
  }
};

/** Reads what one frame shows of a preview; see the module comment. */
export function usePreviewData({
  services,
  chrome,
  scope,
  artifactId,
  blockRevision,
}: PreviewDataInput): PreviewData {
  const [record, setRecord] = useState<ArtifactRecord | undefined>(undefined);
  const [policy, setPolicy] = useState<'proceed' | 'request'>('proceed');
  const [preview, setPreview] = useState<PreviewState | undefined>(undefined);
  const [selectedRevision, setSelectedRevision] = useState<number | undefined>(
    blockRevision,
  );
  const [reloadTick, setReloadTick] = useState(0);
  const [commentsTick, setCommentsTick] = useState(0);
  const [comments, setComments] = useState<readonly PreviewComment[]>([]);
  const [logEvents, setLogEvents] = useState<
    readonly ThreadLogEvent[] | undefined
  >(undefined);
  const [items, setItems] = useState<readonly ComposerItem[]>([]);
  const [logStates, setLogStates] =
    useState<PreviewStates>(initialPreviewStates);

  const composerReady = useSyncExternalStore(
    subscribeComposer,
    composerAvailable,
    composerAvailable,
  );

  // The scope as a dependency: its identity may change on every render.
  const projectId = scope?.projectId;
  const threadId = scope?.threadId;

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  /* The record and the policy ------------------------------------------------ */

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick is the reread's trigger
  useEffect(() => {
    if (projectId === undefined) return;

    let cancelled = false;
    const call = callScopeOf({
      projectId,
      ...(threadId === undefined ? {} : { threadId }),
    });
    const artifacts = services.use(ArtifactsV1, call);
    // Before the window knows its revision, it asks for the newest.
    const asked = selectedRevision;

    artifacts
      .read(
        asked === undefined ? { artifactId } : { artifactId, revision: asked },
      )
      .then((next) => {
        if (cancelled) return;
        setRecord(next);
        if (asked === undefined && next !== undefined) {
          setSelectedRevision(next.revision);
        }
      })
      .catch(() => undefined);

    artifacts
      .policy()
      .then((answer) => {
        if (!cancelled) setPolicy(answer.policy);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [services, projectId, threadId, artifactId, selectedRevision, reloadTick]);

  /* The markup of the revision on screen ------------------------------------- */

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick is the reread's trigger
  useEffect(() => {
    if (projectId === undefined || selectedRevision === undefined) return;

    let cancelled = false;

    services
      .use(
        PapercraftPreviewsV1,
        callScopeOf({
          projectId,
          ...(threadId === undefined ? {} : { threadId }),
        }),
      )
      .read({ artifactId, revision: selectedRevision })
      .then((state) => {
        if (!cancelled) setPreview(state);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [services, projectId, threadId, artifactId, selectedRevision, reloadTick]);

  /* The durable comments of the preview, on every revision ------------------- */

  // `comments/v1.list` filters a target by its exact revision, so the list is
  // read by kind and narrowed to this preview here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ticks are the reread's triggers
  useEffect(() => {
    if (projectId === undefined) return;

    let cancelled = false;

    services
      .use(
        CommentsV1,
        callScopeOf({
          projectId,
          ...(threadId === undefined ? {} : { threadId }),
        }),
      )
      .list({ kind: ARTIFACT_TARGET_KIND })
      .then((list) => {
        if (!cancelled) {
          setComments(
            list
              .filter(
                (comment) =>
                  comment.target.kind === ARTIFACT_TARGET_KIND &&
                  comment.target.id === artifactId,
              )
              .map(commentOfList),
          );
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [services, projectId, threadId, artifactId, reloadTick, commentsTick]);

  /* The comments of the Thread's log, shared by every frame of the Thread ---- */

  // The log names who answered, what was resolved and under which prompt each
  // comment was written; while it has not answered (or cannot), the list
  // stands in.
  useEffect(() => {
    if (projectId === undefined || threadId === undefined) return;

    const release = watchThreadComments(
      services,
      { projectId, threadId },
      setLogEvents,
    );

    return () => {
      release();
      setLogEvents(undefined);
    };
  }, [services, projectId, threadId]);

  /* The drafts of the Thread's composer stack -------------------------------- */

  useEffect(() => {
    if (!composerReady || projectId === undefined || threadId === undefined)
      return;

    const composer = composerFor(services, { projectId, threadId });

    if (composer === undefined) return;

    let current: readonly ComposerItem[] = [];
    let subscription: { dispose(): void } | undefined;

    try {
      // The portrait first, then the deltas — the shape of
      // `runtime.threads/v1.watchThread`.
      subscription = composer.api.watch(composer.threadId, (watch) => {
        switch (watch.kind) {
          case 'snapshot':
            current = watch.items;
            break;
          case 'added':
            current = [...current, watch.item];
            break;
          case 'updated':
            current = current.map((candidate) =>
              candidate.id === watch.item.id ? watch.item : candidate,
            );
            break;
          case 'removed':
            current = current.filter((candidate) => candidate.id !== watch.id);
            // A draft leaves the stack when the send flushes it: its durable
            // comment is the one to read now.
            setCommentsTick((tick) => tick + 1);
            break;
          case 'text':
            return;
        }

        setItems(current);
      });
    } catch {
      return;
    }

    return () => {
      subscription?.dispose();
      setItems([]);
    };
  }, [services, composerReady, projectId, threadId]);

  /* The window: the Thread's log, live --------------------------------------- */

  useEffect(() => {
    if (
      chrome !== 'canvas' ||
      projectId === undefined ||
      threadId === undefined
    )
      return;

    let states = initialPreviewStates();
    let subscription: { dispose(): void } | undefined;

    const apply = (event: ThreadLogEvent): void => {
      states = applyPreviewEvent(states, event).states;
    };

    try {
      subscription = services
        .use(RuntimeThreadsV1, callScopeOf({ projectId, threadId }))
        .watchThread({ threadId, afterSequence: 0 }, (item) => {
          if (item.kind === 'snapshot') {
            for (const event of item.events) apply(event);
            setLogStates(states);

            return;
          }

          if (item.kind !== 'event') return;

          const event = item.event;

          if (!namesArtifact(event, artifactId)) return;

          if (ARTIFACT_EVENT.test(event.type)) {
            apply(event);
            setLogStates(states);
            setReloadTick((tick) => tick + 1);
          } else if (COMMENT_EVENT.test(event.type)) {
            setCommentsTick((tick) => tick + 1);
          }
        });
    } catch {
      // A composition without the Thread's watch: the window keeps the
      // registry's reading.
      return;
    }

    return () => subscription?.dispose();
  }, [services, chrome, projectId, threadId, artifactId]);

  const drafts = useMemo(
    () =>
      items.flatMap((item) => {
        const draft = draftOfItem(item, artifactId);

        return draft === undefined ? [] : [draft];
      }),
    [items, artifactId],
  );

  const threads = useMemo(
    () =>
      threadsOf(
        logEvents === undefined
          ? comments
          : commentsOfEvents(logEvents, artifactId),
      ),
    [logEvents, comments, artifactId],
  );

  const reloadComments = useCallback(
    () => setCommentsTick((tick) => tick + 1),
    [],
  );

  const logApproved =
    logStates
      .get(artifactId)
      ?.revisions.find((item) => item.revision === selectedRevision)
      ?.approved === true;

  // The record read is the revision on screen's, so its state is that
  // revision's; the log's approvals name the revision explicitly.
  const approved =
    selectedRevision !== undefined &&
    (logApproved ||
      (record?.revision === selectedRevision && record.state === 'approved'));

  return {
    record,
    policy,
    preview,
    selectedRevision,
    selectRevision: setSelectedRevision,
    reload,
    threads,
    drafts,
    reloadComments,
    canComment:
      composerReady &&
      projectId !== undefined &&
      threadId !== undefined &&
      selectedRevision !== undefined,
    approved,
  };
}
