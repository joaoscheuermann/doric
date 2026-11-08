// `program-data.ts` — what one canvas reads of a papercraft program (D6, D14,
// D16, D19, D26), as `preview-data.ts` reads an artifact's.
//
// Every host call carries the canvas's scope, `{ projectId, threadId }`:
//
//   - the revisions of the identity, from the window's fold of the Thread's
//     papercraft fences: the fences chat handed the node, or in the window
//     the ones `chat.views/v1.watchFences` streams;
//   - the library bound at the shown revision's turn
//     (`papercraft.programs/v1.library`), its bytes read from the host and
//     stored in the desktop's verified cache (`papercraft.cache/v1.ensure`)
//     once per window, a `read` that answers `not_found` asking the library
//     again once;
//   - each literal `Export` of the program, at most `MAX_EXPORTS` distinct
//     keys, built once per canvas and cached the same way;
//   - the durable comments of the identity and its drafts in the Thread's
//     composer stack, as the artifact's are read.

import { ContractError, type Services } from 'bundle/contracts';
import {
  createErrorReporter,
  type ErrorReporter,
  OpenuiProgramsV1,
  type ProgramRevision,
  type ReportedError,
  type ShownError,
  shownErrors,
} from 'openui/contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  type ChatFence,
  ChatViewsV1,
  type ComposerItem,
} from '../../contracts/chat.js';
import {
  type Comment,
  CommentsV1,
  callScopeOf,
  MODULES_URL,
  type ModuleRef,
  PapercraftCacheV1,
  PapercraftProgramsV1,
  PROGRAM_COMMENT_KIND,
  PROGRAM_TARGET_KIND,
  type PreviewScope,
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
  commentsOfEvents,
  type PreviewComment,
  type PreviewThread,
  threadsOf,
} from '../domain/preview-state.js';
import { PAPERCRAFT_TAG, programFolds } from '../folds.js';
import type { ProgramModule } from '../frame-protocol.js';
import { split, tokenize } from '../openui-adapter.js';
import { exportCalls, MAX_EXPORTS, programErrors } from '../program-errors.js';
import type { ProgramContent } from './live-frame.js';
import { watchThreadComments } from './thread-log.js';

/** What the canvas knows of the library bound at the shown revision's turn. */
export type LibraryView =
  | { readonly status: 'pending' }
  | { readonly status: 'none' | 'ready'; readonly library?: ProgramModule }
  | { readonly status: 'failed'; readonly error: string };

export interface ProgramDataInput {
  readonly services: Services;
  readonly chrome: 'node' | 'canvas';
  readonly scope: PreviewScope | undefined;
  readonly threadId: string;
  readonly identity: string;
  /** The node's fence: the revision it shows. */
  readonly fenceKey?: string;
  /** The node's fences, as chat handed them; the window watches its own. */
  readonly fences?: readonly ChatFence[];
}

/** One revision of the identity, with the fence it was written in. */
export interface ProgramRevisionOf {
  readonly revision: ProgramRevision;
  readonly fence: ChatFence;
}

export interface ProgramData {
  /** The identity's revisions, in transcript order; `undefined` before the window's first list. */
  readonly revisions: readonly ProgramRevisionOf[] | undefined;
  readonly selected: ProgramRevisionOf | undefined;
  readonly selectRevision: (revision: number) => void;
  readonly library: LibraryView;
  /** The frame's `init` and `program`, once the library answered. */
  readonly content: ProgramContent | undefined;
  /**
   * The card under the canvas (D18, D26): the library's failure, then, once
   * the fence is complete, the shown revision's errors; `sent` once the node
   * reported them.
   */
  readonly errors: {
    readonly lines: readonly ShownError[];
    readonly sent: boolean;
  };
  /** The frame's errors: kept for the card, and reported by the node (D18) unless the library failed. */
  readonly onErrors: (errors: readonly OpenUIErrorOf[]) => void;
  readonly threads: readonly PreviewThread[];
  readonly drafts: readonly PreviewDraft[];
  readonly reloadComments: () => void;
  readonly canComment: boolean;
}

/** One entry of the frame's `errors` message. */
export interface OpenUIErrorOf {
  readonly code: string;
  readonly statementId?: string;
  readonly message: string;
}

const NOT_READ = 'The module could not be read from the host';
const LIMIT_MESSAGE = `Too many exports in one program: at most ${String(MAX_EXPORTS)}.`;
const MAX_MESSAGE = 300;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isNotFound = (error: unknown): boolean =>
  error instanceof ContractError
    ? error.code === 'not_found'
    : (error as { readonly code?: unknown } | undefined)?.code === 'not_found';

/** D14's URLs of a module, served under `/papercraft-modules/`. */
export const moduleUrlsOf = (ref: ModuleRef): ProgramModule => ({
  module: `${MODULES_URL}${ref.dir}/index.js`,
  ...(ref.files.some((file) => file.path === 'index.css')
    ? { styles: `${MODULES_URL}${ref.dir}/index.css` }
    : {}),
});

/** Each window's ensured modules, by `dir`: a window is its services. */
const ensuredOf = new WeakMap<Services, Map<string, Promise<void>>>();

/**
 * Reads a module's bytes from the host and stores them in the desktop's
 * verified cache, once per window and `dir`; a failure is forgotten, so the
 * next call tries again. Rejects with the host's `not_found` as it came.
 */
const ensureModule = (
  services: Services,
  scope: PreviewScope,
  ref: ModuleRef,
): Promise<void> => {
  const ensured = ensuredOf.get(services) ?? new Map<string, Promise<void>>();
  ensuredOf.set(services, ensured);
  const known = ensured.get(ref.dir);

  if (known !== undefined) return known;

  const call = callScopeOf(scope);
  const ensuring = (async () => {
    const { entries } = await services
      .use(PapercraftProgramsV1, call)
      .read({ dir: ref.dir });
    const result = await services
      .use(PapercraftCacheV1, call)
      .ensure({ entries });
    const refused = result.failed.find(
      (entry) => entry.path === `${ref.dir}/index.js`,
    );

    if (refused !== undefined)
      throw new Error(`the cache refused the module: ${refused.message}`);
  })();

  ensured.set(ref.dir, ensuring);
  ensuring.catch(() => ensured.delete(ref.dir));

  return ensuring;
};

/** D14: the library bound at `turnSequence`, ensured into the cache. */
const useLibrary = (
  services: Services,
  scope: PreviewScope | undefined,
  turnSequence: number | undefined,
): LibraryView => {
  const [view, setView] = useState<LibraryView>({ status: 'pending' });
  const projectId = scope?.projectId;
  const threadId = scope?.threadId;

  useEffect(() => {
    if (projectId === undefined || turnSequence === undefined) return;

    let live = true;
    const scoped: PreviewScope = {
      projectId,
      ...(threadId === undefined ? {} : { threadId }),
    };
    const programs = services.use(PapercraftProgramsV1, callScopeOf(scoped));

    const load = async (retried = false): Promise<LibraryView> => {
      const answer = await programs.library({ turnSequence });

      if (answer.status === 'none') return { status: 'none' };
      if (answer.status === 'failed')
        return { status: 'failed', error: answer.error };

      try {
        await ensureModule(services, scoped, answer.module);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        if (retried) return { status: 'failed', error: NOT_READ };

        return load(true);
      }

      return { status: 'ready', library: moduleUrlsOf(answer.module) };
    };

    setView({ status: 'pending' });
    void load()
      .catch(
        (error: unknown): LibraryView => ({
          status: 'failed',
          error: messageOf(error),
        }),
      )
      .then((next) => {
        if (live) setView(next);
      });

    return () => {
      live = false;
    };
  }, [services, projectId, threadId, turnSequence]);

  return view;
};

/** D16: each literal `Export` of `program`, the first `MAX_EXPORTS` keys, built once per canvas. */
const useExports = (
  services: Services,
  scope: PreviewScope | undefined,
  program: string | undefined,
): {
  readonly calls: ReturnType<typeof exportCalls>;
  readonly keys: readonly string[];
  readonly built: Readonly<Record<string, ProgramModule>>;
  readonly failed: Readonly<Record<string, string>>;
} => {
  const asked = useRef(new Set<string>());
  const [built, setBuilt] = useState<Readonly<Record<string, ProgramModule>>>(
    {},
  );
  const [failed, setFailed] = useState<Readonly<Record<string, string>>>({});
  const calls = useMemo(
    () => (program === undefined ? [] : exportCalls(program)),
    [program],
  );
  const keys = useMemo(
    () => [...new Set(calls.map((call) => call.key))],
    [calls],
  );
  const projectId = scope?.projectId;
  const threadId = scope?.threadId;

  useEffect(() => {
    if (projectId === undefined) return;

    const scoped: PreviewScope = {
      projectId,
      ...(threadId === undefined ? {} : { threadId }),
    };

    for (const key of keys.slice(0, MAX_EXPORTS)) {
      if (asked.current.has(key)) continue;
      asked.current.add(key);

      const call = calls.find((one) => one.key === key);

      if (call === undefined) continue;

      const build = async (): Promise<ProgramModule> => {
        const answer = await services
          .use(PapercraftProgramsV1, callScopeOf(scoped))
          .export({
            path: call.path,
            ...(call.name === undefined ? {} : { name: call.name }),
          });

        if (answer.status === 'failed') throw new Error(answer.error);
        await ensureModule(services, scoped, answer.module);

        return moduleUrlsOf(answer.module);
      };

      build().then(
        (module) => setBuilt((current) => ({ ...current, [key]: module })),
        (error: unknown) =>
          setFailed((current) => ({
            ...current,
            [key]: `Export ${key} did not build: ${messageOf(error)}`.slice(
              0,
              MAX_MESSAGE,
            ),
          })),
      );
    }
  }, [services, projectId, threadId, calls, keys]);

  return { calls, keys, built, failed };
};

/** The statement names of `program`; none when it cannot be read. */
const statementsOf = (program: string): ReadonlySet<string> => {
  try {
    return new Set(split(tokenize(program)).map((statement) => statement.id));
  } catch {
    return new Set();
  }
};

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

/** The window's own list of the Thread's papercraft fences (D26). */
const useWatchedFences = (
  services: Services,
  scope: PreviewScope | undefined,
  enabled: boolean,
): readonly ChatFence[] | undefined => {
  const [fences, setFences] = useState<readonly ChatFence[] | undefined>(
    undefined,
  );
  const projectId = scope?.projectId;
  const threadId = scope?.threadId;

  useEffect(() => {
    if (!enabled || projectId === undefined || threadId === undefined) return;

    const registration = services.whenAvailable(ChatViewsV1, (views) => {
      const watch = views.watchFences(
        { projectId, threadId, tag: PAPERCRAFT_TAG },
        (next) => setFences(next),
      );

      return () => watch.dispose();
    });

    return () => registration.dispose();
  }, [services, enabled, projectId, threadId]);

  return fences;
};

/** Reads what one canvas shows of a papercraft program; see the module comment. */
export function useProgramData(input: ProgramDataInput): ProgramData {
  const { services, chrome, scope, threadId, identity, fenceKey } = input;
  const watched = useWatchedFences(services, scope, input.fences === undefined);
  const fences = input.fences ?? watched;
  const [chosen, setChosen] = useState<number | undefined>(undefined);
  const [commentsTick, setCommentsTick] = useState(0);
  const [comments, setComments] = useState<readonly PreviewComment[]>([]);
  const [logEvents, setLogEvents] = useState<
    readonly ThreadLogEvent[] | undefined
  >(undefined);
  const [items, setItems] = useState<readonly ComposerItem[]>([]);
  const composerReady = useSyncExternalStore(
    subscribeComposer,
    composerAvailable,
    composerAvailable,
  );

  // The fold of the Thread's papercraft fences, held while the canvas is.
  const [hold, setHold] = useState(() =>
    programFolds.hold(threadId, PAPERCRAFT_TAG),
  );
  useEffect(() => {
    const held = programFolds.hold(threadId, PAPERCRAFT_TAG);
    setHold(held);

    return () => held.release();
  }, [threadId]);
  useEffect(() => () => hold.release(), [hold]);

  const revisions = useMemo(() => {
    if (fences === undefined) return undefined;

    const byKey = hold.fold.revisions(fences);

    return fences.flatMap((fence) => {
      const revision = byKey.get(fence.key);

      return revision === undefined || revision.identity !== identity
        ? []
        : [{ revision, fence }];
    });
  }, [fences, hold, identity]);

  const selected =
    revisions === undefined
      ? undefined
      : fenceKey !== undefined
        ? revisions.find((one) => one.fence.key === fenceKey)
        : (revisions.find((one) => one.revision.revision === chosen) ??
          revisions.at(-1));

  const library = useLibrary(services, scope, selected?.fence.turnSequence);
  const program = selected?.revision.program;
  const exports = useExports(services, scope, program);

  const streaming = selected?.fence.state === 'streaming';
  // D5: the raw body while revision 1 streams, else the merged program.
  const text =
    selected === undefined
      ? undefined
      : streaming && selected.revision.revision === 1
        ? selected.fence.body
        : selected.revision.program;

  const builtKeys = useMemo(
    () =>
      Object.fromEntries(
        exports.keys
          .slice(0, MAX_EXPORTS)
          .flatMap((key) =>
            exports.built[key] === undefined
              ? []
              : [[key, exports.built[key]] as const],
          ),
      ),
    [exports.keys, exports.built],
  );

  const libraryModule =
    library.status === 'ready' || library.status === 'none'
      ? library.library
      : undefined;
  const content = useMemo<ProgramContent | undefined>(
    () =>
      library.status === 'pending' || text === undefined
        ? undefined
        : {
            init: libraryModule === undefined ? {} : { library: libraryModule },
            message: { text, streaming, exports: builtKeys },
          },
    [library.status, libraryModule, text, streaming, builtKeys],
  );

  /** The app's own check of the program at the report (D6, D16). */
  const exportErrors = useMemo((): readonly ReportedError[] => {
    const errors: ReportedError[] = [];

    exports.keys.forEach((key, index) => {
      const call = exports.calls.find((one) => one.key === key);

      if (call === undefined) return;
      if (index >= MAX_EXPORTS) {
        errors.push({
          code: 'runtime-error',
          statementId: call.statementId,
          message: LIMIT_MESSAGE,
        });
      } else if (exports.failed[key] !== undefined) {
        errors.push({
          code: 'render-error',
          statementId: call.statementId,
          message: exports.failed[key],
        });
      }
    });

    return errors;
  }, [exports.keys, exports.calls, exports.failed]);

  // D18: one reporter per fence revision; the node reports, the window does
  // not, and nothing is reported for a library that failed.
  const latest = useRef({
    program,
    exportErrors,
    state: selected?.fence.state,
  });
  latest.current = { program, exportErrors, state: selected?.fence.state };
  const projectId = scope?.projectId;
  const scopeThread = scope?.threadId;
  const reportKey = selected?.fence.key;
  const reportRevision = selected?.revision.revision;
  const mergeFailed = selected?.revision.mergeFailed === true;
  const reporter = useMemo((): ErrorReporter | undefined => {
    if (
      chrome !== 'node' ||
      projectId === undefined ||
      reportKey === undefined ||
      reportRevision === undefined
    )
      return undefined;

    const call = callScopeOf({
      projectId,
      ...(scopeThread === undefined ? {} : { threadId: scopeThread }),
    });

    return createErrorReporter({
      tag: 'papercraft',
      key: reportKey,
      identity,
      revision: reportRevision,
      mergeFailed,
      check: () => [
        ...programErrors(latest.current.program ?? ''),
        ...latest.current.exportErrors,
      ],
      map: (error) => {
        const statements = statementsOf(latest.current.program ?? '');

        if (
          error.statementId !== undefined &&
          !statements.has(error.statementId)
        )
          return undefined;

        // The frame's text is the Project's word: only its code and statement go.
        return {
          code: error.code as ReportedError['code'],
          ...(error.statementId === undefined
            ? {}
            : { statementId: error.statementId }),
        };
      },
      send: (report) =>
        services.use(OpenuiProgramsV1, call).reportErrors(report),
    });
  }, [
    chrome,
    services,
    projectId,
    scopeThread,
    identity,
    reportKey,
    reportRevision,
    mergeFailed,
  ]);
  const libraryFailed = library.status === 'failed';

  // The frame's last list of errors, for the shown fence revision only.
  const [frameErrors, setFrameErrors] = useState<{
    readonly key: string | undefined;
    readonly revision: number | undefined;
    readonly errors: readonly OpenUIErrorOf[];
  }>({ key: undefined, revision: undefined, errors: [] });
  const onErrors = useCallback(
    (errors: readonly OpenUIErrorOf[]) => {
      setFrameErrors({ key: reportKey, revision: reportRevision, errors });
      const state = latest.current.state;

      if (state === undefined || libraryFailed) return;
      reporter?.onError(errors, state);
    },
    [reporter, reportKey, reportRevision, libraryFailed],
  );
  const lastErrors =
    frameErrors.key === reportKey && frameErrors.revision === reportRevision
      ? frameErrors.errors
      : [];

  const complete =
    selected?.fence.state === 'closed' ||
    selected?.fence.state === 'unterminated';
  const lines = useMemo(
    (): readonly ShownError[] => [
      ...(library.status === 'failed'
        ? [
            {
              message: `Drawn without the repository library: ${library.error}`,
            },
          ]
        : []),
      ...(complete
        ? shownErrors({
            mergeFailed,
            owned: [...programErrors(program ?? ''), ...exportErrors],
            rendered: lastErrors,
          })
        : []),
    ],
    [library, complete, mergeFailed, program, exportErrors, lastErrors],
  );
  const sent = reporter?.sent() ?? false;

  /* The durable comments of the identity, and its drafts ------------------- */

  // biome-ignore lint/correctness/useExhaustiveDependencies: the tick is the reread's trigger
  useEffect(() => {
    if (projectId === undefined || logEvents !== undefined) return;

    let cancelled = false;

    services
      .use(
        CommentsV1,
        callScopeOf({
          projectId,
          ...(scopeThread === undefined ? {} : { threadId: scopeThread }),
        }),
      )
      .list({ kind: PROGRAM_TARGET_KIND })
      .then((list) => {
        if (cancelled) return;
        setComments(
          list
            .filter(
              (comment) =>
                comment.target.kind === PROGRAM_TARGET_KIND &&
                comment.target.id === identity,
            )
            .map(commentOfList),
        );
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [services, projectId, scopeThread, identity, commentsTick, logEvents]);

  useEffect(() => {
    if (projectId === undefined || scopeThread === undefined) return;

    const release = watchThreadComments(
      services,
      { projectId, threadId: scopeThread },
      setLogEvents,
    );

    return () => {
      release();
      setLogEvents(undefined);
    };
  }, [services, projectId, scopeThread]);

  useEffect(() => {
    if (!composerReady || projectId === undefined || scopeThread === undefined)
      return;

    let current: readonly ComposerItem[] = [];
    let subscription: { dispose(): void } | undefined;

    try {
      // A window whose services have no composer has no stack to read.
      const composer = composerFor(services, {
        projectId,
        threadId: scopeThread,
      });

      if (composer === undefined) return;

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
  }, [services, composerReady, projectId, scopeThread]);

  const drafts = useMemo(
    () =>
      items.flatMap((item) => {
        const draft = draftOfItem(item, identity, {
          item: PROGRAM_COMMENT_KIND,
          target: PROGRAM_TARGET_KIND,
        });

        return draft === undefined ? [] : [draft];
      }),
    [items, identity],
  );

  const threads = useMemo(
    () =>
      threadsOf(
        logEvents === undefined
          ? comments
          : commentsOfEvents(logEvents, identity, PROGRAM_TARGET_KIND),
      ),
    [logEvents, comments, identity],
  );

  const reloadComments = useCallback(
    () => setCommentsTick((tick) => tick + 1),
    [],
  );

  return {
    revisions,
    selected,
    selectRevision: setChosen,
    library,
    content,
    errors: { lines, sent },
    onErrors,
    threads,
    drafts,
    reloadComments,
    canComment:
      composerReady &&
      projectId !== undefined &&
      scopeThread !== undefined &&
      selected !== undefined,
  };
}
