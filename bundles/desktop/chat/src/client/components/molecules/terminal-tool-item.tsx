import { cn } from 'desktop/ui/utils';
import { TerminalIcon } from 'lucide-react';

import { type Chosen, toolOpenness } from '../../domain/collapsible.js';
import type { ToolStatus } from '../../domain/projector.js';
import {
  formatCommandPreview,
  formatDuration,
  parseTerminalCall,
  type TerminalStream,
} from '../../domain/terminal-tool.js';
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
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {stream.head.join('\n')}
        </pre>
      ) : null}
      {stream.omittedLines > 0 ? (
        <div className="my-1 select-none text-[11px] text-muted-foreground italic">
          … {stream.omittedLines} {stream.omittedLines === 1 ? 'line' : 'lines'}{' '}
          omitted …
        </div>
      ) : null}
      {stream.tail.length > 0 ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {stream.tail.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * A `terminal` tool call rendered as a shell card: its header names the command,
 * duration and exit status, and its body shows the command line, working
 * directory and captured `stdout`/`stderr` streams.
 */
export function TerminalToolItem({
  args,
  chosen,
  error,
  focused,
  onChosenChange,
  result,
  status,
}: TerminalToolItemProps) {
  const running = status === 'running';
  const parsed = parseTerminalCall(args, result);
  const failed =
    status === 'failed' ||
    parsed.success === false ||
    (parsed.exitCode !== undefined && parsed.exitCode !== 0);
  const verb = running ? 'Running' : failed ? 'Failed' : 'Ran';
  const preview = formatCommandPreview(parsed.command);
  const duration =
    parsed.durationMs === undefined ? '' : formatDuration(parsed.durationMs);
  const hasStdout = hasStreamLines(parsed.stdout);
  const hasStderr = hasStreamLines(parsed.stderr);
  const hasOutput =
    hasStdout ||
    hasStderr ||
    (parsed.rawOutput !== undefined && parsed.rawOutput.length > 0) ||
    error !== undefined;

  const label = (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <TerminalIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0">{verb}</span>
      {preview.length > 0 ? (
        <code
          data-slot="terminal-command-preview"
          className="truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs text-foreground"
        >
          {preview}
        </code>
      ) : (
        <span>terminal</span>
      )}
      {parsed.background === true ? (
        <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          background
        </span>
      ) : null}
      {parsed.terminationReason === 'timeout' ? (
        <span className="shrink-0 text-xs text-destructive">timeout</span>
      ) : parsed.exitCode !== undefined && parsed.exitCode !== 0 ? (
        <span
          data-slot="terminal-exit-code"
          className="shrink-0 text-xs text-destructive tabular-nums"
        >
          exit {parsed.exitCode}
        </span>
      ) : null}
      {duration.length > 0 ? (
        <span
          data-slot="terminal-duration"
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {duration}
        </span>
      ) : null}
    </span>
  );

  return (
    <div data-slot="terminal-tool">
      <CollapsibleBlock
        chosen={chosen}
        focused={focused}
        label={label}
        onChosenChange={onChosenChange}
        openness={toolOpenness(status, args, result, error, 'terminal')}
      >
        <div className="overflow-hidden rounded-md border border-border bg-card/50 font-mono text-xs">
          {(parsed.command !== undefined && parsed.command.length > 0) ||
          parsed.workingDirectory !== undefined ? (
            <div className="flex flex-col gap-0.5 border-b border-border/60 bg-muted/30 px-2.5 py-1.5">
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
              {parsed.workingDirectory !== undefined &&
              parsed.workingDirectory.length > 0 ? (
                <div
                  data-slot="terminal-cwd"
                  className="truncate text-[11px] text-muted-foreground"
                >
                  {parsed.workingDirectory}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto px-2.5 py-2">
            {hasStdout && parsed.stdout !== undefined ? (
              <StreamBlock stream={parsed.stdout} tone="stdout" />
            ) : null}
            {hasStderr && parsed.stderr !== undefined ? (
              <StreamBlock stream={parsed.stderr} tone="stderr" />
            ) : null}
            {parsed.rawOutput !== undefined && parsed.rawOutput.length > 0 ? (
              <pre
                data-slot="terminal-raw-output"
                className="whitespace-pre-wrap break-words font-mono text-xs text-foreground/90"
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
            {!hasOutput && !running ? (
              <div className="text-muted-foreground italic">
                {parsed.background === true
                  ? parsed.terminalId !== undefined
                    ? `Started in background (${parsed.terminalId})`
                    : 'Started in background'
                  : 'No output'}
              </div>
            ) : null}
          </div>
        </div>
      </CollapsibleBlock>
    </div>
  );
}
