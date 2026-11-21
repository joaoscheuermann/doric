// The `terminal-tool-call` element (bundle isolation 5(b), change 4): the row
// a `terminal` call draws in the chat's transcript, moved from the chat's
// `components/molecules/terminal-tool-item.tsx` and registered through
// `chat.views/v1`. The chat creates one element per call and sets its `view`;
// the element draws the row from it and reports the reader's open/close
// choice with `chat-block-chosen`.
//
// While its terminal runs, the row shows the terminal's live output and a
// Stop action, from this bundle's store (`client.store`) and output watch
// (`client.watches`), never from the chat:
// - it follows the call's Project through the store, and never unfollows it
//   (the sidebar's rows read the same followed list);
// - it watches the output only while the terminal runs (`useLiveOutput`);
// - Stop asks the store to stop the terminal, whose refusal is the store's
//   toast, and is gone at once for that terminal, for the element's life.

import type { Services } from 'bundle/contracts';
import type { ErrorCatalog, ErrorInfo } from 'desktop/reads';
import {
  blockOpen,
  type Chosen,
  CollapsibleBlock,
  type Openness,
} from 'desktop/ui/collapsible-block';
import { ErrorNotice } from 'desktop/ui/error-notice';
import { defineReactElement } from 'desktop/ui/react-element';
import { cn } from 'desktop/ui/utils';
import { SquareIcon } from 'lucide-react';
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { matchLiveTerminal } from '../domain/live-terminal.js';
import {
  formatCommandPreview,
  parseTerminalCall,
  type TerminalStream,
} from '../domain/terminal-tool.js';
import type { Terminal } from '../domain/terminals.js';
import type { TerminalClient } from '../elements.js';
import { useSubscribed } from '../hooks.js';
import { CHAT_BLOCK_CHOSEN_EVENT, type ChatToolView } from '../peers.js';
import { useLiveOutput } from './live-output.js';

/** The tag `terminal` defines through `ui/v1` and registers for the `terminal` tool. */
export const TERMINAL_CALL_TAG = 'terminal-tool-call';

/** The tool whose calls the row draws. */
export const TERMINAL_TOOL = 'terminal';

/** Where a call is: running, or settled one way or the other. */
type ToolStatus = ChatToolView['status'];

/**
 * The codes the terminal blocks' failure notice names beside the shared
 * entries: `tool_failed`, its fallback (OD-6).
 */
export const terminalToolCatalog: ErrorCatalog = {
  tool_failed: { title: 'Tool failed', retryable: false },
};

/**
 * A call's answer by the chat's generic rule (its `toolOpenness`): open while
 * it runs, once the call shows anything, and folded once it settles.
 */
const toolOpenness = (
  status: ToolStatus,
  args: string,
  result: string | undefined,
  error: ErrorInfo | undefined,
): Openness => ({
  active: status === 'running',
  hasContent: args.length > 0 || result !== undefined || error !== undefined,
});

/** The answer of a call whose terminal still runs: open, whatever its status. */
const liveOpenness: Openness = {
  active: true,
  hasContent: true,
  defaultOpen: true,
};

/** The verbs a terminal block's header names its command's state with. */
export type TerminalVerbs = {
  readonly running: string;
  readonly ran: string;
  readonly failed: string;
};

/** A `terminal` tool call's own verbs. */
const TOOL_VERBS: TerminalVerbs = {
  running: 'Running',
  ran: 'Ran',
  failed: 'Failed',
};

const hasStreamLines = (stream: TerminalStream | undefined): boolean =>
  stream !== undefined &&
  (stream.head.length > 0 || stream.tail.length > 0 || stream.omittedLines > 0);

function StreamBlock({
  slot,
  stream,
  tone,
}: {
  readonly slot: string;
  readonly stream: TerminalStream;
  readonly tone: 'stdout' | 'stderr';
}) {
  const textClass =
    tone === 'stderr' ? 'text-destructive' : 'text-foreground/90';

  return (
    <div
      data-slot={`${slot}-${tone}`}
      className={cn('flex flex-col', textClass)}
    >
      {stream.head.length > 0 ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">
          {stream.head.join('\n')}
        </pre>
      ) : null}
      {stream.omittedLines > 0 ? (
        <div className="my-0.5 select-none text-sm text-muted-foreground">
          … {stream.omittedLines} {stream.omittedLines === 1 ? 'line' : 'lines'}{' '}
          omitted …
        </div>
      ) : null}
      {stream.tail.length > 0 ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">
          {stream.tail.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}

type TerminalBlockProps = {
  /**
   * The verbs the header names its command's state with, before the command's
   * preview: a tool call ran, a background result answers a command the agent
   * left behind.
   */
  readonly verbs: TerminalVerbs;
  /** The command as it was run, drawn behind its `$`. */
  readonly command?: string;
  /**
   * What the header names the block by when it has no command to preview; a
   * result whose command did not survive its envelope says nothing more than
   * the verb.
   */
  readonly noun?: string;
  readonly stdout?: TerminalStream;
  readonly stderr?: TerminalStream;
  /** The output of a run still in flight, drawn in place of the streams. */
  readonly liveOutput?: string;
  /** The result text, when it is not a `terminal.compact.v1` record. */
  readonly rawOutput?: string;
  readonly error?: ErrorInfo;
  /** The Stop action, which only a run still in flight offers. */
  readonly stopAction?: ReactNode;
  /** Whether the header says the command failed. */
  readonly failed: boolean;
  /** Whether the command is still running. */
  readonly running: boolean;
  readonly openness: Openness;
  readonly chosen: Chosen;
  readonly focused?: boolean;
  readonly onChosenChange: (chosen: boolean) => void;
  /** What a screen reader names the header's toggle by, when not its text. */
  readonly toggleLabel?: string;
  /**
   * The slot the card is named by; the rows inside it take `<slot>-command`,
   * `<slot>-stdout` and so on — a tool call and the result the host reports for
   * a background command are the same card, each named for what it is.
   */
  readonly slot: string;
  /** Whether a background call said it keeps running past its block. */
  readonly startedInBackground?: boolean;
};

/**
 * A terminal's card: a minimal header (`Running/Ran/Failed <command>`) and a
 * single `rounded-md border border-border bg-card/50` body (without a vertical
 * guide line) holding the command behind its `$` and the streams the run kept.
 * While the command runs, live output streams into the card and the header
 * offers a `Stop` action.
 *
 * A `terminal` tool call and the answer of a background one draw this same
 * card; they differ only in the verbs their header names them by and in where
 * their output comes from — the call's own record, or the prompt the host
 * enqueues when the command settles.
 */
export function TerminalBlock({
  verbs,
  command,
  noun,
  stdout,
  stderr,
  liveOutput,
  rawOutput,
  error,
  stopAction,
  failed,
  running,
  openness,
  chosen,
  focused,
  onChosenChange,
  toggleLabel,
  slot,
  startedInBackground = false,
}: TerminalBlockProps) {
  const verb = running ? verbs.running : failed ? verbs.failed : verbs.ran;
  const preview = formatCommandPreview(command);
  const hasCommand = command !== undefined && command.length > 0;
  const open = blockOpen(chosen, openness);

  const label = (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle font-light">
      <span className="shrink-0 font-normal">{verb}</span>
      {preview.length > 0 ? (
        <span
          data-slot={`${slot}-command-preview`}
          className="truncate font-mono"
        >
          {preview}
        </span>
      ) : noun === undefined ? null : (
        <span>{noun}</span>
      )}
    </span>
  );

  return (
    <CollapsibleBlock
      chosen={chosen}
      focused={focused}
      guide={false}
      label={label}
      onChosenChange={onChosenChange}
      openness={openness}
      {...(toggleLabel === undefined ? {} : { toggleLabel })}
    >
      {open ? (
        <div
          data-slot={slot}
          className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-card/50 px-3 py-2 font-mono text-sm"
        >
          {hasCommand || stopAction !== undefined ? (
            <div className="flex items-center justify-between gap-2">
              {hasCommand ? (
                <div
                  data-slot={`${slot}-command`}
                  className="min-w-0 flex-1 truncate text-foreground"
                >
                  <span className="mr-1.5 select-none text-muted-foreground">
                    $
                  </span>
                  {command}
                </div>
              ) : null}
              {stopAction}
            </div>
          ) : null}
          {liveOutput !== undefined && liveOutput.length > 0 ? (
            <pre
              data-slot={`${slot}-live-output`}
              className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground/90"
            >
              {liveOutput}
            </pre>
          ) : null}
          {stdout !== undefined && hasStreamLines(stdout) ? (
            <StreamBlock slot={slot} stream={stdout} tone="stdout" />
          ) : null}
          {stderr !== undefined && hasStreamLines(stderr) ? (
            <StreamBlock slot={slot} stream={stderr} tone="stderr" />
          ) : null}
          {rawOutput !== undefined && rawOutput.length > 0 ? (
            <pre
              data-slot={`${slot}-raw-output`}
              className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground/90"
            >
              {rawOutput}
            </pre>
          ) : null}
          {error === undefined ? null : (
            <ErrorNotice
              variant="compact"
              error={error}
              catalog={terminalToolCatalog}
              fallbackCode="tool_failed"
              context={{ Tool: TERMINAL_TOOL }}
            />
          )}
          {startedInBackground ? (
            <div className="text-muted-foreground">Started in background</div>
          ) : null}
        </div>
      ) : null}
    </CollapsibleBlock>
  );
}

/** The live session a call's row shows while its terminal runs. */
export type LiveSession = {
  /** The terminal the call follows. */
  readonly terminal: Terminal;
  /** Its output seen so far, the last 32,000 characters. */
  readonly output: string | undefined;
};

type TerminalToolItemProps = {
  readonly args: string;
  readonly error?: ErrorInfo;
  readonly result?: string;
  readonly status: ToolStatus;
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  readonly focused?: boolean;
  /** The terminal the call follows and its output, when there is one. */
  readonly live?: LiveSession;
  /** Stops the live terminal; Stop is offered only with it. */
  readonly onStop?: (terminalId: string) => void;
};

/** What a `terminal` call's row draws, read from the call and its live terminal. */
const readCall = (
  props: Pick<TerminalToolItemProps, 'args' | 'result' | 'error' | 'status'> & {
    readonly live: LiveSession | undefined;
  },
) => {
  const { args, result, error, status, live } = props;
  const parsed = parseTerminalCall(args, result);
  const liveActive =
    live !== undefined &&
    (live.terminal.state === 'starting' || live.terminal.state === 'running');
  const running = status === 'running' || liveActive;
  const failed =
    !running &&
    (status === 'failed' ||
      parsed.success === false ||
      (parsed.exitCode !== undefined && parsed.exitCode !== 0));
  const hasStdout = hasStreamLines(parsed.stdout);
  const hasStderr = hasStreamLines(parsed.stderr);
  const hasSettledOutput =
    hasStdout ||
    hasStderr ||
    (parsed.rawOutput !== undefined && parsed.rawOutput.length > 0);
  const openness = liveActive
    ? liveOpenness
    : toolOpenness(status, args, result, error);
  return {
    parsed,
    liveActive,
    running,
    failed,
    hasStdout,
    hasStderr,
    hasSettledOutput,
    openness,
  };
};

/**
 * A `terminal` tool call: the tool read into its command and streams, and the
 * card the run settles into, with its live terminal's output streaming into
 * it while the terminal runs.
 */
export const TerminalToolItem = memo(function TerminalToolItem({
  args,
  chosen,
  error,
  focused,
  onChosenChange,
  result,
  status,
  live,
  onStop,
}: TerminalToolItemProps) {
  const {
    parsed,
    liveActive,
    running,
    failed,
    hasStdout,
    hasStderr,
    hasSettledOutput,
    openness,
  } = useMemo(
    () => readCall({ args, result, error, status, live }),
    [args, result, error, status, live],
  );
  const liveOutput = !hasSettledOutput ? (live?.output ?? '') : '';

  const stopAction =
    liveActive && live !== undefined && onStop !== undefined ? (
      <button
        type="button"
        data-slot="terminal-stop"
        aria-label="Stop"
        title="Stop"
        className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={() => onStop(live.terminal.id)}
      >
        <SquareIcon aria-hidden="true" className="size-3 fill-current" />
      </button>
    ) : undefined;

  return (
    <TerminalBlock
      verbs={TOOL_VERBS}
      chosen={chosen}
      command={parsed.command}
      error={error}
      failed={failed}
      focused={focused}
      liveOutput={liveOutput}
      noun="terminal"
      onChosenChange={onChosenChange}
      openness={openness}
      rawOutput={parsed.rawOutput}
      running={running}
      slot="terminal"
      startedInBackground={
        parsed.background === true &&
        !hasSettledOutput &&
        liveOutput.length === 0 &&
        error === undefined
      }
      stderr={hasStderr ? parsed.stderr : undefined}
      stdout={hasStdout ? parsed.stdout : undefined}
      stopAction={stopAction}
    />
  );
});

/** Dispatches the reader's choice from `target`; it bubbles to the element. */
export const dispatchChosen = (target: EventTarget, chosen: boolean): void => {
  target.dispatchEvent(
    new CustomEvent<{ readonly chosen: boolean }>(CHAT_BLOCK_CHOSEN_EVENT, {
      detail: { chosen },
      bubbles: true,
      composed: true,
    }),
  );
};

/** What each element's block shows now, as its `toggle()` reads it (O2). */
const shownOpen = new WeakMap<Element, boolean>();

/** What the chat sets on the element. */
interface TerminalCallProps {
  readonly view?: ChatToolView;
}

/**
 * The element class over `client`: maps `view` (`ChatToolView`) to the row,
 * with the call's live terminal from the store, and dispatches
 * `chat-block-chosen` for the reader's choice. Its `toggle()` (O2) reports the
 * opposite of what the row shows, by the live rule: a call whose terminal
 * still runs is open, whatever its status.
 */
export const defineTerminalCallElement = (client: TerminalClient) => {
  const { store, watches } = client;

  /**
   * Draws the row of the element's `view` from its root, whose parent is the
   * element: the choice it dispatches bubbles to the element, and what it
   * shows is kept for the element's `toggle()`.
   */
  function TerminalCall({
    view,
  }: TerminalCallProps & { readonly services: Services }) {
    const root = useRef<HTMLDivElement>(null);
    const projectId = view?.projectId;
    useEffect(() => {
      // Idempotent; the sidebar follows the same Projects, so no unfollow.
      if (projectId !== undefined && projectId.length > 0)
        store.follow(projectId);
    }, [projectId]);
    const terminals = useSubscribed(store, () => store.terminals(), []);
    // The terminals the reader stopped from this row: Stop is gone at once,
    // whatever the stream says next.
    const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
    // The reader's click, shown until the chat sets the next `view`.
    const [clicked, setClicked] = useState<
      { readonly view: ChatToolView; readonly chosen: boolean } | undefined
    >(undefined);

    const parsed = useMemo(
      () =>
        view === undefined
          ? undefined
          : parseTerminalCall(view.args, view.result),
      [view],
    );
    const matched =
      view === undefined || parsed === undefined
        ? undefined
        : matchLiveTerminal(terminals, {
            threadId: view.threadId,
            ...(parsed.command === undefined
              ? {}
              : { command: parsed.command }),
            ...(parsed.terminalId === undefined
              ? {}
              : { terminalId: parsed.terminalId }),
            toolRunning: view.status === 'running',
          });
    const terminal = useMemo(
      () =>
        matched !== undefined && stopped.has(matched.id)
          ? { ...matched, state: 'exited' as const }
          : matched,
      [matched, stopped],
    );
    const output = useLiveOutput(watches, terminal);
    const live = useMemo(
      () => (terminal === undefined ? undefined : { terminal, output }),
      [terminal, output],
    );

    const onStop = useCallback((terminalId: string) => {
      setStopped((previous) => new Set([...previous, terminalId]));
      store.stop(terminalId);
    }, []);
    const onChosenChange = useCallback(
      (chosen: boolean) => {
        if (view !== undefined) setClicked({ view, chosen });
        if (root.current !== null) dispatchChosen(root.current, chosen);
      },
      [view],
    );

    const chosen =
      clicked !== undefined && clicked.view === view
        ? clicked.chosen
        : (view?.chosen ?? null);
    const open =
      view === undefined
        ? undefined
        : blockOpen(
            chosen,
            readCall({
              args: view.args,
              result: view.result,
              error: view.error,
              status: view.status,
              live,
            }).openness,
          );
    useLayoutEffect(() => {
      const host = root.current?.parentElement;
      if (host === null || host === undefined) return;
      if (open === undefined) shownOpen.delete(host);
      else shownOpen.set(host, open);
    });

    if (view === undefined) return null;
    return (
      <div ref={root} data-slot="terminal-tool">
        <TerminalToolItem
          args={view.args}
          {...(view.result === undefined ? {} : { result: view.result })}
          {...(view.error === undefined ? {} : { error: view.error })}
          status={view.status}
          chosen={chosen}
          focused={view.focused}
          onChosenChange={onChosenChange}
          {...(live === undefined ? {} : { live })}
          onStop={onStop}
        />
      </div>
    );
  }

  const Base = defineReactElement<TerminalCallProps>({
    props: ['view'],
    render: TerminalCall,
  });
  return class TerminalCallElement extends Base {
    declare view: ChatToolView | undefined;

    toggle(): void {
      const open = shownOpen.get(this);
      if (open !== undefined) dispatchChosen(this, !open);
    }
  };
};
