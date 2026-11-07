// `<openui-fence>` (conversation-openui.md D29): the element chat creates for
// each `openui-lang` fence. `FenceShell` draws the fence's source until the
// renderer chunk loads, then the chunk's `ConversationFence`.

import type { Services } from 'bundle/contracts';
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  firstCompletedLine,
  type ProgramFold,
  type ProgramRevision,
} from '../contracts/index.js';
import { watchAnswers } from './answer-changes.js';
import type { ChatFence, ChatFenceView } from './chat-contract.js';
import type { ChunkLoader } from './folds.js';

/** The element's tag. */
export const FENCE_ELEMENT_TAG = 'openui-fence';

/** `FenceShell`'s props: the element's `view` (a `ChatFenceView` when valid) and services. */
export interface FenceShellProps {
  readonly view?: unknown;
  readonly services: Services;
}

/**
 * The element's component over `loader`. It calls `loader.load()` at its
 * first render and draws, in this order: a fence with no completed line that
 * is not blank as source with "Writing…" (D2's footer when `unterminated`);
 * a failed load as "The UI renderer did not load: <message>" beside the
 * source; a pending load as source with "Drawing…"; once loaded, the chunk's
 * `ConversationFence` with the fence's revision from the held fold of the
 * Thread and `openui-lang`, `latest` and `superseded`. It holds that fold
 * while mounted and releases it on unmount. A `view` that is not a
 * `ChatFenceView` draws nothing.
 */
export const createFenceShell = (
  loader: ChunkLoader,
): ComponentType<FenceShellProps> =>
  function FenceShell({ view, services }: FenceShellProps): ReactNode {
    return isFenceView(view) ? (
      <ShellOf loader={loader} view={view} services={services} />
    ) : null;
  };

/** The fence tag this element draws. */
const TAG = 'openui-lang';

/** D2's footer under a fence its answer left open. */
const UNTERMINATED = 'Incomplete: the answer ended before the fence closed';

type Load =
  | { readonly state: 'pending' }
  | { readonly state: 'loaded' }
  | { readonly state: 'failed'; readonly message: string };

function ShellOf({
  loader,
  view,
  services,
}: {
  readonly loader: ChunkLoader;
  readonly view: ChatFenceView;
  readonly services: Services;
}): ReactNode {
  const [load, setLoad] = useState<Load>(() =>
    loader.loaded() === undefined ? { state: 'pending' } : { state: 'loaded' },
  );

  useEffect(() => {
    let live = true;
    loader.load().then(
      () => {
        if (live) setLoad({ state: 'loaded' });
      },
      (error: unknown) => {
        if (live) {
          setLoad({
            state: 'failed',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [loader]);

  const { fence } = view;
  const loaded = load.state === 'loaded' ? loader.loaded() : undefined;
  const [fold, setFold] = useState<ProgramFold | undefined>(undefined);

  // The fold of the Thread and tag, held while the element is mounted (D4).
  useEffect(() => {
    if (loaded === undefined) return;
    const held = loaded.folds.hold(fence.threadId, TAG);
    setFold(held.fold);
    return () => {
      held.release();
      setFold(undefined);
    };
  }, [loaded, fence.threadId]);

  const readings = useMemo(() => {
    if (loaded === undefined || fold === undefined) return undefined;
    const fences = view.fences.filter((one) => tagOf(one) === TAG);
    const revisions = fold.revisions(fences);
    const questions = new Map<string, boolean>();
    const valid = (key: string, revision: ProgramRevision): boolean => {
      let answer = questions.get(key);
      if (answer === undefined) {
        answer = loaded.chunk.questionOf(revision.program).input !== undefined;
        questions.set(key, answer);
      }
      return answer;
    };
    return { fences, revisions, valid };
  }, [loaded, fold, view.fences]);

  if (firstCompletedLine(fence) === undefined) {
    return (
      <Source
        fence={fence}
        line={fence.state === 'unterminated' ? UNTERMINATED : 'Writing…'}
      />
    );
  }

  if (load.state === 'failed') {
    return (
      <Source
        fence={fence}
        line={`The UI renderer did not load: ${load.message}`}
      />
    );
  }

  const revision = readings?.revisions.get(fence.key);
  if (
    loaded === undefined ||
    readings === undefined ||
    revision === undefined
  ) {
    return <Source fence={fence} line="Drawing…" />;
  }

  const at = readings.fences.findIndex((one) => one.key === fence.key);
  const later = at < 0 ? [] : readings.fences.slice(at + 1);
  const latest = !later.some(
    (one) => readings.revisions.get(one.key)?.identity === revision.identity,
  );
  const superseded =
    revision.question &&
    later.some((one) => {
      const next = readings.revisions.get(one.key);
      return (
        one.state === 'closed' &&
        next !== undefined &&
        next.question &&
        readings.valid(one.key, next)
      );
    });
  const { ConversationFence } = loaded.chunk;

  return (
    <ConversationFence
      view={view}
      revision={revision}
      latest={latest}
      superseded={superseded}
      services={services}
      watchAnswers={watchAnswers}
    />
  );
}

/** The fence's source, as the chat's code block draws it, with a line under it. */
function Source({
  fence,
  line,
}: {
  readonly fence: ChatFence;
  readonly line: string;
}): ReactNode {
  return (
    <div className="flex w-full flex-col gap-1">
      <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
        <code>{fence.body}</code>
      </pre>
      <p className="text-xs text-muted-foreground">{line}</p>
    </div>
  );
}

/** The first word of a fence's info string. */
const tagOf = (fence: ChatFence): string | undefined =>
  fence.info.trim().split(/\s+/)[0];

const STATES: readonly string[] = ['streaming', 'closed', 'unterminated'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isFence = (value: unknown): value is ChatFence =>
  isRecord(value) &&
  typeof value.key === 'string' &&
  typeof value.projectId === 'string' &&
  typeof value.threadId === 'string' &&
  typeof value.promptId === 'string' &&
  typeof value.turnSequence === 'number' &&
  typeof value.index === 'number' &&
  typeof value.info === 'string' &&
  typeof value.body === 'string' &&
  typeof value.state === 'string' &&
  STATES.includes(value.state);

/** Whether `view` is the `ChatFenceView` the chat sets. */
const isFenceView = (view: unknown): view is ChatFenceView =>
  isRecord(view) &&
  isFence(view.fence) &&
  (view.origin === 'user' || view.origin === 'agent') &&
  Array.isArray(view.fences) &&
  view.fences.every(isFence);
