// What one `<drawio-diagram>` node reads (spec "O node mostra a revisão"):
// the first page's drawing from the cache or drawn now, the revision's XML
// and model, and the diagram's durable threads and drafts. Nothing here is
// application state: every reading is rebuilt from the services.

import {
  type DoricConnection,
  DoricConnectionV1,
  type Services,
} from 'bundle/contracts';
import {
  type CanvasComment,
  type CanvasDraft,
  type CanvasThread,
  commentsOfEvents,
  type ThreadLogEvent,
  type ThreadWatchSource,
  threadsOf,
  useAppTheme,
  watchThreadComments,
} from 'desktop/ui/canvas';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import type { ComposerItem } from '../contracts/chat.js';
import {
  ARTIFACT_TARGET_KIND,
  type Comment,
  CommentsV1,
  callScopeOf,
  type DiagramAnchor,
  type DiagramScope,
  type DiagramSvgEntry,
  DrawioDiagramsV1,
  DrawioSvgV1,
  RuntimeThreadsV1,
} from '../contracts/index.js';
import { type DiagramView, diagramAnchorOf } from './anchor.js';
import {
  composerAvailable,
  composerFor,
  draftOfItem,
  subscribeComposer,
} from './comment.js';
import { type DiagramDrawing, drawPage, sha256Hex } from './drawing.js';
import type { DiagramBlockData } from './elements.js';
import { type DiagramModel, diagramModelOf } from './model.js';

/**
 * Why the node shows no drawing, or shows it without a sandbox:
 * - `missing`: `read` answered `missing`;
 * - `unreadable`: the XML's SHA-256 is not the block's, or the model could
 *   not be read or has no page; nothing is drawn or stored;
 * - `draw`: render or measure rejected, or `status()` answered
 *   `available: false` (Q5); `retry` draws again;
 * - `unleased`: `read` answered `unleased`, with or without a cached `entry`.
 */
export type DiagramFailure = 'missing' | 'unreadable' | 'draw' | 'unleased';

/** What the node draws, as `useDiagramData` reads it. */
export interface DiagramData {
  /**
   * The drawing of the requested page (`pageId`, else the first page, D18) of
   * `block`'s revision in the app's theme, from the cache or just drawn.
   * Absent from a change of `block.artifactId`, `block.revision`,
   * `block.sha256` or `pageId` until that drawing arrives; a theme change
   * keeps the shown one meanwhile.
   */
  readonly entry?: DiagramSvgEntry;
  /** The revision's model, once the leased read passed the SHA-256 check. */
  readonly model?: DiagramModel;
  /** The revision's XML that passed the SHA-256 check; present exactly when `model` is. */
  readonly xml?: string;
  /** The artifact's revision count that same `drawio.diagrams/v1.read` answered; present exactly when `model` is. */
  readonly revisions?: number;
  /**
   * What the hit-test and `placeAnchor` read: present exactly when `entry`
   * is, with `pageId` the page shown (the `pageId` the cache answered, or
   * the page just drawn) and `layout` the entry's;
   * `page` and `pageIds` only once `model` is read.
   */
  readonly view?: DiagramView;
  readonly failure?: DiagramFailure;
  /**
   * The diagram's durable threads, on every revision, oldest root first. A
   * comment whose anchor `diagramAnchorOf` rejects carries no anchor (and so
   * gets no pin).
   */
  readonly threads: readonly CanvasThread<DiagramAnchor>[];
  /** The diagram's drafts in the Thread's composer stack (`draftOfItem`). */
  readonly drafts: readonly CanvasDraft<DiagramAnchor>[];
  /** Rereads the durable comments (after a resolve). */
  readonly reloadComments: () => void;
  /**
   * The composer is active, the scope names a Thread, the revision was read
   * (`model` present, no `failure`) and a drawing is shown.
   */
  readonly canComment: boolean;
  /** Starts the reading again from the cache lookup, clearing `failure` meanwhile. */
  readonly retry: () => void;
}

/** What `useDiagramData` reads with. */
export interface DiagramDataInput {
  readonly services: Services;
  /** Every host call's scope; without one the node reads nothing. */
  readonly scope: DiagramScope | undefined;
  readonly block: DiagramBlockData;
  readonly drawing: DiagramDrawing;
  /**
   * The page to show (the modal's page bar). Absent: the revision's first
   * page, exactly as before — `drawio.svg/v1.get` without `pageId` (the
   * cache's first-page pointer) and, on a miss, `drawPage` of
   * `model.pages[0]` with `first: true`. Present: `get` with this `pageId`;
   * on a miss, `drawPage` of this page, with `first: true` exactly when it is
   * `model.pages[0].id`. A page the model does not have fails as `draw`.
   * Changing it never rereads `drawio.diagrams/v1`.
   */
  readonly pageId?: string;
}

/**
 * The node's reading, in the steps of spec "O node mostra a revisão":
 * 1. `drawio.svg/v1.get({ artifactId, revision, sha256: block.sha256,
 *    theme: useAppTheme() })`, without `pageId`: the cache resolves the
 *    revision's first page through its pointer — no lease, also after a
 *    restart. A hit is the `entry`, and its `pageId` the page shown;
 * 2. `drawio.diagrams/v1.read({ artifactId, revision })`, in parallel with
 *    step 1; on `ok`, the SHA-256 of the XML (`sha256Hex`) must be
 *    `block.sha256`, else `unreadable`;
 * 3. `diagramModelOf(xml)`; without a page, `unreadable`;
 * 4. still without an entry: `drawio.svg/v1.status()`; `available: false`
 *    is `draw`, else `drawPage({ key: { artifactId, revision, sha256,
 *    pageId: model.pages[0].id, theme }, xml, first: true }, drawing,
 *    DrawioSvgV1)`, which records the pointer with the entry.
 * Without `block.sha256` or a scope nothing is read. A theme change re-keys:
 * step 1 runs for the other theme, and step 4 draws on a miss (which needs
 * the read; unleased, it stays a placeholder). Nothing throws out of the
 * hook; a failed host call ends in a `failure`, a failed `put` is ignored.
 *
 * Threads: `watchThreadComments` through `runtime.threads/v1` and
 * `doric.connection/v1` (each optional); until the log answers, and without
 * the watch, `comments/v1.list({ kind: 'artifact' })` narrowed to this
 * artifact. Drafts: `chat.composer/v1.watch`, re-bound whenever
 * `composerAvailable` turns true; a `removed` item rereads the comments.
 */
export const useDiagramData: (input: DiagramDataInput) => DiagramData = ({
  services,
  scope,
  block,
  drawing,
  pageId,
}) => {
  const theme = useAppTheme();
  const [drawn, setShown] = useState<
    | {
        readonly entry: DiagramSvgEntry;
        readonly pageId: string;
        readonly key: string;
      }
    | undefined
  >(undefined);
  const [revision, setRevision] = useState<
    | {
        readonly xml: string;
        readonly model: DiagramModel;
        readonly revisions: number;
      }
    | undefined
  >(undefined);
  const [failure, setFailure] = useState<DiagramFailure | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [commentsTick, setCommentsTick] = useState(0);
  const [comments, setComments] = useState<
    readonly CanvasComment<DiagramAnchor>[]
  >([]);
  const [logEvents, setLogEvents] = useState<
    readonly ThreadLogEvent[] | undefined
  >(undefined);
  const [items, setItems] = useState<readonly ComposerItem[]>([]);

  const composerReady = useSyncExternalStore(
    subscribeComposer,
    composerAvailable,
    composerAvailable,
  );

  // The scope and the block as dependencies: their identity may change on
  // every render.
  const projectId = scope?.projectId;
  const threadId = scope?.threadId;
  const { artifactId, revision: revisionNumber, sha256 } = block;
  // What the shown drawing belongs to: a change drops it, a theme change keeps it.
  const shownKey = `${artifactId}@${String(revisionNumber)}/${sha256 ?? ''}/${pageId ?? ''}`;
  const shown = drawn?.key === shownKey ? drawn : undefined;

  /* The revision's XML and model --------------------------------------------- */

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the reread's trigger
  useEffect(() => {
    if (projectId === undefined || sha256 === undefined) return;

    let cancelled = false;

    setRevision(undefined);
    setFailure(undefined);

    const read = async (): Promise<void> => {
      const answer = await services
        .use(
          DrawioDiagramsV1,
          callScopeOf({
            projectId,
            ...(threadId === undefined ? {} : { threadId }),
          }),
        )
        .read({ artifactId, revision: revisionNumber });

      if (cancelled) return;

      if (answer.status !== 'ok') {
        setFailure(answer.status === 'missing' ? 'missing' : 'unleased');

        return;
      }

      const hash = await sha256Hex(answer.xml);

      if (cancelled) return;

      if (hash !== sha256) {
        setFailure('unreadable');

        return;
      }

      let model: DiagramModel;

      try {
        model = diagramModelOf(answer.xml);
      } catch {
        setFailure('unreadable');

        return;
      }

      if (model.pages.length === 0) {
        setFailure('unreadable');

        return;
      }

      setRevision({ xml: answer.xml, model, revisions: answer.revisions });
    };

    read().catch(() => {
      if (!cancelled) setFailure('missing');
    });

    return () => {
      cancelled = true;
    };
  }, [
    services,
    projectId,
    threadId,
    artifactId,
    revisionNumber,
    sha256,
    attempt,
  ]);

  /* The first page's drawing: the cache, else drawn now ---------------------- */

  const [missedKey, setMissedKey] = useState<string | undefined>(undefined);
  const lookupKey = `${shownKey}/${theme}/${String(attempt)}`;

  useEffect(() => {
    if (projectId === undefined || sha256 === undefined) return;

    let cancelled = false;

    services
      .use(DrawioSvgV1)
      .get({
        artifactId,
        revision: revisionNumber,
        sha256,
        theme,
        ...(pageId === undefined ? {} : { pageId }),
      })
      .then(
        (page) => {
          if (cancelled) return;
          if (page === null) {
            setMissedKey(lookupKey);
          } else {
            setShown({
              entry: { svg: page.svg, layout: page.layout },
              pageId: page.pageId,
              key: shownKey,
            });
          }
        },
        () => {
          if (!cancelled) setMissedKey(lookupKey);
        },
      );

    return () => {
      cancelled = true;
    };
  }, [
    services,
    projectId,
    artifactId,
    revisionNumber,
    sha256,
    theme,
    pageId,
    shownKey,
    lookupKey,
  ]);

  const missed = missedKey === lookupKey;

  useEffect(() => {
    if (!missed || revision === undefined || sha256 === undefined) return;

    const firstPage = revision.model.pages[0];

    if (firstPage === undefined) return;

    const page = pageId ?? firstPage.id;
    const first = page === firstPage.id;

    if (!revision.model.pages.some((candidate) => candidate.id === page)) {
      setFailure('draw');

      return;
    }

    let cancelled = false;
    const svgs = services.use(DrawioSvgV1);

    const draw = async (): Promise<void> => {
      const status = await svgs.status();

      if (cancelled) return;

      if (!status.available) {
        setFailure('draw');

        return;
      }

      const entry = await drawPage(
        {
          key: {
            artifactId,
            revision: revisionNumber,
            sha256,
            pageId: page,
            theme,
          },
          xml: revision.xml,
          ...(first ? { first: true as const } : {}),
        },
        drawing,
        svgs,
      );

      if (!cancelled) setShown({ entry, pageId: page, key: shownKey });
    };

    draw().catch(() => {
      if (!cancelled) setFailure('draw');
    });

    return () => {
      cancelled = true;
    };
  }, [
    missed,
    revision,
    services,
    drawing,
    artifactId,
    revisionNumber,
    sha256,
    theme,
    pageId,
    shownKey,
  ]);

  const retry = useCallback(() => {
    setFailure(undefined);
    setAttempt((tick) => tick + 1);
  }, []);

  /* The durable comments of the diagram, on every revision ------------------- */

  // biome-ignore lint/correctness/useExhaustiveDependencies: commentsTick is the reread's trigger
  useEffect(() => {
    if (projectId === undefined || logEvents !== undefined) return;

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
  }, [services, projectId, threadId, artifactId, commentsTick, logEvents]);

  useEffect(() => {
    if (projectId === undefined || threadId === undefined) return;

    const threadScope = { projectId, threadId };
    let source: ThreadWatchSource;
    let connection: DoricConnection | undefined;

    try {
      source = services.use(RuntimeThreadsV1, threadScope);
    } catch {
      return;
    }

    try {
      connection = services.use(DoricConnectionV1);
    } catch {
      connection = undefined;
    }

    const release = watchThreadComments(
      source,
      connection,
      threadScope,
      setLogEvents,
    );

    return () => {
      release();
      setLogEvents(undefined);
    };
  }, [services, projectId, threadId]);

  /* The drafts of the Thread's composer stack -------------------------------- */

  useEffect(() => {
    if (!composerReady || projectId === undefined || threadId === undefined) {
      return;
    }

    const composer = composerFor(services, { projectId, threadId });

    if (composer === undefined) return;

    let current: readonly ComposerItem[] = [];
    let subscription: { dispose(): void } | undefined;

    try {
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
          : commentsOfEvents<unknown>(logEvents, artifactId).map(checked),
      ),
    [logEvents, comments, artifactId],
  );

  const reloadComments = useCallback(
    () => setCommentsTick((tick) => tick + 1),
    [],
  );

  const model = revision?.model;
  const view = useMemo<DiagramView | undefined>(() => {
    if (shown === undefined) return undefined;

    const page = model?.pages.find(
      (candidate) => candidate.id === shown.pageId,
    );

    return {
      pageId: shown.pageId,
      layout: shown.entry.layout,
      ...(model === undefined
        ? {}
        : { pageIds: model.pages.map((candidate) => candidate.id) }),
      ...(page === undefined ? {} : { page }),
    };
  }, [shown, model]);

  return {
    ...(shown === undefined ? {} : { entry: shown.entry }),
    ...(revision === undefined
      ? {}
      : {
          model: revision.model,
          xml: revision.xml,
          revisions: revision.revisions,
        }),
    ...(view === undefined ? {} : { view }),
    ...(failure === undefined ? {} : { failure }),
    threads,
    drafts,
    reloadComments,
    canComment:
      composerReady &&
      projectId !== undefined &&
      threadId !== undefined &&
      model !== undefined &&
      failure === undefined &&
      shown !== undefined,
    retry,
  };
};

/** A log comment with its anchor checked by `diagramAnchorOf`: dropped when not a diagram anchor. */
const checked = (
  comment: CanvasComment<unknown>,
): CanvasComment<DiagramAnchor> => {
  const { anchor: raw, ...rest } = comment;
  const anchor = diagramAnchorOf(raw);

  return anchor === undefined ? rest : { ...rest, anchor };
};

/** A comment `comments/v1.list` answered, in the canvas's shape. */
const commentOfList = (comment: Comment): CanvasComment<DiagramAnchor> => {
  const { promptId } = comment;

  return checked({
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
  });
};
