import { cn } from 'desktop/ui/utils';
import { memo, useMemo } from 'react';

import {
  blockOpen,
  type Chosen,
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

type TerminalToolItemProps = {
  readonly args: string;
  readonly error?: string;
  readonly result?: string;
  readonly status: ToolStatus;
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  readonly focused?: boolean;
};

const hasStreamLines = (stream: TerminalStream | undefined): boolean =>
  stream !== undefined &&
  (stream.head.length > 0 || stream.tail.length > 0 || stream.omittedLines > 0);

function StreamBlock({
  stream,
  tone,
}: {
  readonly stream: TerminalStream;
  readonly tone: 'stdout' | 'stderr';
}) {
  const textClass =
    tone === 'stderr' ? 'text-destructive' : 'text-foreground/90';

  return (
    <div
      data-slot={`terminal-${tone}`}
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

/**
 * A `terminal` tool call rendered with a minimal header (`Running/Ran/Failed
 * <command>`) and a single `rounded-md border border-border bg-card/50` body
 * card (without a vertical guide line). While the command is running, live
 * output streams into the card and a `Stop` action appears in the header.
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
  const verb = running ? 'Running' : failed ? 'Failed' : 'Ran';
  const preview = formatCommandPreview(parsed.command);
  const hasStdout = hasStreamLines(parsed.stdout);
  const hasStderr = hasStreamLines(parsed.stderr);
  const hasSettledOutput =
    hasStdout ||
    hasStderr ||
    (parsed.rawOutput !== undefined && parsed.rawOutput.length > 0);
  const liveOutput = !hasSettledOutput && live ? live.output : '';
  const hasLiveOutput = liveOutput.length > 0;
  const baseOpenness = toolOpenness(status, args, result, error, 'terminal');
  const openness = liveActive
    ? { active: true, hasContent: true, defaultOpen: true }
    : baseOpenness;
  const open = blockOpen(chosen, openness);

  const label = (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <span className="shrink-0">{verb}</span>
      {preview.length > 0 ? (
        <span
          data-slot="terminal-command-preview"
          className="truncate font-mono"
        >
          {preview}
        </span>
      ) : (
        <span>terminal</span>
      )}
    </span>
  );

  const stopAction = liveActive ? (
    <button
      type="button"
      data-slot="terminal-stop"
      className="shrink-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
      onClick={() => stopLiveTerminal(live.terminal.id)}
    >
      Stop
    </button>
  ) : undefined;

  return (
    <div data-slot="terminal-tool">
      <CollapsibleBlock
        chosen={chosen}
        focused={focused}
        guide={false}
        label={label}
        onChosenChange={onChosenChange}
        openness={openness}
        trailing={stopAction}
      >
        {open ? (
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-card/50 px-3 py-2 font-mono text-sm">
            {parsed.command !== undefined && parsed.command.length > 0 ? (
              <div
                data-slot="terminal-command"
                className="whitespace-pre-wrap break-all text-foreground"
              >
                <span className="mr-1.5 select-none text-muted-foreground">
                  $
                </span>
                {parsed.command}
              </div>
            ) : null}
            {hasLiveOutput ? (
              <pre
                data-slot="terminal-live-output"
                className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground/90"
              >
                {liveOutput}
              </pre>
            ) : null}
            {hasStdout && parsed.stdout !== undefined ? (
              <StreamBlock stream={parsed.stdout} tone="stdout" />
            ) : null}
            {hasStderr && parsed.stderr !== undefined ? (
              <StreamBlock stream={parsed.stderr} tone="stderr" />
            ) : null}
            {parsed.rawOutput !== undefined && parsed.rawOutput.length > 0 ? (
              <pre
                data-slot="terminal-raw-output"
                className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground/90"
              >
                {parsed.rawOutput}
              </pre>
            ) : null}
            {error !== undefined && error.length > 0 ? (
              <div
                data-slot="terminal-error"
                className="whitespace-pre-wrap break-words text-destructive"
              >
                {error}
              </div>
            ) : null}
            {parsed.background === true &&
            !hasSettledOutput &&
            !hasLiveOutput &&
            error === undefined ? (
              <div className="text-muted-foreground">Started in background</div>
            ) : null}
          </div>
        ) : null}
      </CollapsibleBlock>
    </div>
  );
});
