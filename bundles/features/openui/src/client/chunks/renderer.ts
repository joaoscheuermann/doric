// The conversation renderer chunk (conversation-openui.md D29), loaded by the
// entry at a window's first fence: the shell's only module that imports
// OpenUI. It draws one fence's program with react-lang's `Renderer` and the
// conversation library (D7, D21, D31).

import { type OpenUIError, Renderer } from '@openuidev/react-lang';
import type { Services } from 'bundle/contracts';
import {
  Component,
  createElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  createErrorReporter,
  OpenuiProgramsV1,
  type ProgramRevision,
  shownErrors,
} from '../../contracts/index.js';
import { actionText } from '../actions.js';
import { type ChatFenceView, ChatSendV1 } from '../chat-contract.js';
import { check, map, programCheck } from '../check.js';
import { createLayoutLoader } from '../diagram/layout-loader.js';
import type { LayoutGraph, LayoutResult } from '../diagram/layout-types.js';
import { library } from '../library.js';
import { FenceContext } from '../question/fence-context.js';
import { ErrorsCard } from './errors-card.js';

export interface AnswerTarget {
  readonly projectId: string;
  readonly threadId: string;
  /** The prompt that wrote the question fence. */
  readonly promptId: string;
}

/** Calls `listener` on each live row `rereadsAnswer` accepts for `target`; returns the release. */
export type WatchAnswers = (
  target: AnswerTarget,
  listener: () => void,
) => () => void;

export interface ConversationFenceProps {
  readonly view: ChatFenceView;
  /** The fence's revision from the fold (D4); the entry renders this component only once there is one. */
  readonly revision: ProgramRevision;
  /** No later fence of `view.fences` has a revision of the same identity. */
  readonly latest: boolean;
  /** A question fence with a later `closed` question fence in `view.fences` whose question passes `askInputSchema` (D21); drawn superseded only while `status` is `pending`. */
  readonly superseded: boolean;
  /** The element's services: `chat.send/v1`, `openui.questions/v1`, `openui.programs/v1`. */
  readonly services: Services;
  /** The entry's `watchAnswers` (`answer-changes.ts`). */
  readonly watchAnswers: WatchAnswers;
  /** The layout the fence's diagrams use; the window's layout loader (F6) when absent. */
  readonly layout?: (graph: LayoutGraph) => Promise<LayoutResult>;
}

type LayoutChunk = typeof import('./layout.js');

/**
 * The window's layout loader (openui-diagrams.md F6): the layout chunk is
 * built beside this one, so its URL is resolved from this module's.
 */
const layoutLoader = createLayoutLoader(
  () =>
    import(
      new URL('./layout.js', import.meta.url).href
    ) as Promise<LayoutChunk>,
);

/**
 * One fence drawn by `Renderer` with D5's text and `isStreaming`, inside an
 * error boundary, with the fence context for `AskForm`, one error reporter
 * per key and revision, its errors under it, and D2's footer when
 * `unterminated`. A crash outside OpenUI's own handling draws "This UI failed
 * to draw" and is reported as `render-error`.
 */
export function ConversationFence(props: ConversationFenceProps): ReactNode {
  const { view, revision, latest, superseded, services, watchAnswers } = props;
  const layout = props.layout ?? layoutLoader;
  const interactive = blockedReason(view, latest) === undefined;
  const { fence } = view;
  const streaming = fence.state === 'streaming';
  // D5: the raw body while revision 1 streams, else the revision's program.
  const response =
    streaming && revision.revision === 1 ? fence.body : revision.program;

  // The check reads the fence as it is when the report is made.
  const current = useRef({ view, revision });
  current.current = { view, revision };

  const reporter = useMemo(
    () =>
      createErrorReporter({
        tag: 'openui-lang',
        key: fence.key,
        identity: revision.identity,
        revision: revision.revision,
        mergeFailed: revision.mergeFailed === true,
        check: () => check(current.current.view, current.current.revision),
        map,
        send: (input) =>
          services
            .use(OpenuiProgramsV1, {
              projectId: fence.projectId,
              threadId: fence.threadId,
            })
            .reportErrors(input),
      }),
    [
      fence.key,
      fence.projectId,
      fence.threadId,
      revision.identity,
      revision.revision,
      revision.mergeFailed,
      services,
    ],
  );

  const [errors, setErrors] = useState<readonly OpenUIError[]>([]);
  const [crash, setCrash] = useState<Error | undefined>(undefined);
  const drawing = `${fence.key}/${revision.revision}`;
  const [crashed, setCrashed] = useState<string | undefined>(undefined);
  const failed = crashed === drawing ? crash : undefined;

  const onError = (next: OpenUIError[]): void => {
    setErrors(next);
    reporter.onError(next, current.current.view.fence.state);
  };

  // A crash outside OpenUI's own handling is reported as `render-error`.
  useEffect(() => {
    if (failed === undefined) return;
    reporter.onError(
      [{ code: 'render-error', message: failed.message || String(failed) }],
      fence.state,
    );
  }, [failed, fence.state, reporter]);

  const onCrash = useCallback(
    (error: Error) => {
      setCrash(error);
      setCrashed(drawing);
    },
    [drawing],
  );

  const actions = useActions({ view, revision, latest, services });

  // The card's lines (D18, U49): none while the fence streams.
  const lines = useMemo(
    () =>
      streaming
        ? []
        : shownErrors({
            mergeFailed: revision.mergeFailed === true,
            owned: programCheck(revision),
            rendered: errors,
          }),
    [streaming, revision, errors],
  );

  const context = useMemo(
    () => ({
      view,
      revision,
      superseded,
      services,
      watchAnswers,
      interactive,
      layout,
    }),
    [view, revision, superseded, services, watchAnswers, interactive, layout],
  );

  return createElement(
    'div',
    { className: 'openui-fence flex w-full flex-col gap-1' },
    createElement(
      'div',
      {
        ref: actions.wrapper,
        className: 'w-full',
        inert: actions.inert,
        'aria-busy': actions.sending ? 'true' : undefined,
      },
      failed === undefined
        ? createElement(
            FenceContext.Provider,
            { value: context },
            createElement(
              DrawBoundary,
              { key: drawing, onCrash },
              createElement(Renderer, {
                response,
                library,
                isStreaming: streaming,
                onAction: actions.onAction,
                onError,
                publishObservability: false,
              }),
            ),
          )
        : createElement(
            'p',
            { role: 'alert', className: 'text-xs text-destructive' },
            `This UI failed to draw: ${failed.message || String(failed)}`,
          ),
    ),
    fence.state === 'streaming' || lines.length === 0
      ? null
      : createElement(ErrorsCard, { lines, sent: reporter.sent() }),
    actions.line === undefined
      ? null
      : createElement(
          'p',
          { role: 'status', className: 'text-xs text-muted-foreground' },
          actions.line,
        ),
    fence.state === 'unterminated'
      ? createElement(
          'p',
          { className: 'text-xs text-muted-foreground' },
          UNTERMINATED,
        )
      : null,
  );
}

/** D2's footer under a fence its answer left open. */
const UNTERMINATED = 'Incomplete: the answer ended before the fence closed';

/** The shortest time a click keeps the fence busy (D20). */
const BUSY_MS = 500;

/** The longest error message the line shows. */
const MAX_LINE_MESSAGE = 300;

/** Why the fence's actions are off (D20), or `undefined` when they work. */
const blockedReason = (
  view: ChatFenceView,
  latest: boolean,
): string | undefined => {
  if (view.origin === 'agent') {
    return "Actions are off in a subagent's thread: only the main thread takes the reader's messages";
  }
  if (view.fence.state === 'unterminated') {
    return 'Actions are off: this UI was cut off before it was complete';
  }
  if (view.fence.state === 'streaming') {
    return 'Actions work once the UI is complete';
  }
  if (!latest) return 'Actions work in the latest version of this UI';
  return undefined;
};

/** D20's click handling: when a click sends, what it sends, and the line under the fence. */
const useActions = ({
  view,
  revision,
  latest,
  services,
}: {
  readonly view: ChatFenceView;
  readonly revision: ProgramRevision;
  readonly latest: boolean;
  readonly services: Services;
}) => {
  const wrapper = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const [sending, setSending] = useState(false);
  const [line, setLine] = useState<string | undefined>(undefined);
  const blocked = blockedReason(view, latest);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const onAction = (event: Parameters<typeof actionText>[0]): void => {
    // A control under an `inert` wrapper takes no click; refuse one anyway.
    if (
      blocked !== undefined ||
      inFlight.current ||
      wrapper.current?.closest('[inert]') != null
    ) {
      return;
    }
    const built = actionText(event);
    if ('line' in built) {
      setLine(built.line);
      return;
    }
    inFlight.current = true;
    const started = Date.now();
    setSending(true);
    setLine('Sending…');
    const { projectId, threadId } = view.fence;
    const settle = (next: string | undefined): void => {
      if (!mounted.current) return;
      setLine(next);
      timer.current = setTimeout(
        () => {
          inFlight.current = false;
          if (mounted.current) setSending(false);
        },
        Math.max(0, BUSY_MS - (Date.now() - started)),
      );
    };
    Promise.resolve()
      .then(() =>
        services.use(ChatSendV1).sendAction({
          projectId,
          threadId,
          program: revision.identity,
          text: built.send,
        }),
      )
      .then(
        (result) =>
          settle(
            result.status === 'accepted'
              ? undefined
              : 'Not sent: the thread did not take the message',
          ),
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          settle(`Not sent: ${message.slice(0, MAX_LINE_MESSAGE)}`);
        },
      );
  };

  return {
    wrapper,
    onAction,
    sending,
    inert: blocked !== undefined || sending,
    line: blocked ?? line,
  };
};

/** Catches a crash of `Renderer` outside OpenUI's per-element handling. */
class DrawBoundary extends Component<
  { readonly onCrash: (error: Error) => void; readonly children?: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onCrash(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** lang-core's merge, as react-lang re-exports it, for the entry's fold. */
export { mergeStatements } from '@openuidev/react-lang';

/** D21's reading of a question fence's program, for the entry's `superseded`. */
export { type QuestionRead, questionOf } from '../question/ask-input.js';
