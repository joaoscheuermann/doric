import { cn } from 'desktop/ui/utils';
import { SquareIcon } from 'lucide-react';
import { memo, type ReactNode, useMemo } from 'react';

import {
  blockOpen,
  type Chosen,
  type Openness,
  toolOpenness,
} from '../../domain/collapsible.js';
import type { ToolStatus } from '../../domain/projector.js';
import {
  formatCommandPreview,
  parseTerminalCall,
  type TerminalStream,
} from '../../domain/terminal-tool.js';
import { useLiveTerminal } from '../../hooks/use-live-terminal.js';
import { stopLiveTerminal } from '../../stores/live-terminals.js';
import { CollapsibleBlock } from './collapsible-block.js';

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
  readonly error?: string;
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
          {error !== undefined && error.length > 0 ? (
            <div
              data-slot={`${slot}-error`}
              className="whitespace-pre-wrap break-words text-destructive"
            >
              {error}
            </div>
          ) : null}
          {startedInBackground ? (
            <div className="text-muted-foreground">Started in background</div>
          ) : null}
        </div>
      ) : null}
    </CollapsibleBlock>
  );
}

type TerminalToolItemProps = {
  readonly args: string;
  readonly error?: string;
  readonly result?: string;
  readonly status: ToolStatus;
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  readonly focused?: boolean;
};

/**
 * A `terminal` tool call: the tool read into its command and streams, and the
 * card the run settles into, with a live terminal streaming into it while the
 * tool waits.
 */
export const TerminalToolItem = memo(function TerminalToolItem({
  args,
  chosen,
  error,
  focused,
  onChosenChange,
  result,
  status,
}: TerminalToolItemProps) {
  const parsed = useMemo(() => parseTerminalCall(args, result), [args, result]);
  const live = useLiveTerminal({
    command: parsed.command,
    terminalId: parsed.terminalId,
    toolRunning: status === 'running',
  });
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
  const liveOutput = !hasSettledOutput && live ? live.output : '';
  const baseOpenness = toolOpenness(status, args, result, error, 'terminal');
  const openness = liveActive
    ? { active: true, hasContent: true, defaultOpen: true }
    : baseOpenness;

  const stopAction = liveActive ? (
    <button
      type="button"
      data-slot="terminal-stop"
      aria-label="Stop"
      title="Stop"
      className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      onClick={() => stopLiveTerminal(live.terminal.id)}
    >
      <SquareIcon aria-hidden="true" className="size-3 fill-current" />
    </button>
  ) : undefined;

  return (
    <div data-slot="terminal-tool">
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
    </div>
  );
});
