import { Button } from 'desktop/ui/button';
import { ToolbarDivider } from 'desktop/ui/panels';
import { Popover, PopoverContent, PopoverTrigger } from 'desktop/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop/ui/tooltip';
import { useEffect, useState } from 'react';

import type { Usage } from '../../contracts/index.js';
import {
  compactResultMessage,
  compactThread,
  readCompactionTarget,
  writeCompactionTarget,
} from '../domain/read.js';
import { contextLabel, costLabel } from '../domain/usage.js';
import { useThreadUsage } from '../hooks/use-thread-usage.js';
import { CostBreakdown } from './cost-breakdown.js';

/** The slider's range, the same one the host's configuration schema names. */
const targetMin = 50;
const targetMax = 95;
const targetDefault = () => 80;

/** The line under the bar: what the fill and the target marker read as. */
const contextLine = (
  usedTokens: number | undefined,
  window: number | undefined,
  target: number,
): string =>
  usedTokens === undefined || window === undefined
    ? `Compacts at ${target}% (window size unknown)`
    : `Compacts at ${target}% of the window`;

/** The popover on the context button: the consumption bar, its target line and the manual compaction. */
function ContextPopover({
  usage,
  threadId,
  usedTokens,
  window: windowSize,
}: {
  readonly usage: Usage;
  readonly threadId: string;
  readonly usedTokens: number | undefined;
  readonly window: number | undefined;
}) {
  const [target, setTarget] = useState<number>(targetDefault());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [note, setNote] = useState<
    { readonly tone: 'info' | 'error'; readonly text: string } | undefined
  >(undefined);

  useEffect(() => {
    let alive = true;
    readCompactionTarget(usage)
      .then((value) => {
        if (alive) {
          setTarget(value.pressurePercent);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (alive)
          setNote({
            tone: 'error',
            text: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      alive = false;
    };
  }, [usage]);

  const usedPercent =
    usedTokens !== undefined && windowSize !== undefined && windowSize > 0
      ? Math.min(100, Math.max(0, Math.round((usedTokens / windowSize) * 100)))
      : undefined;

  const commit = (value: number) => {
    setSaving(true);
    writeCompactionTarget(usage, value)
      .then((moved) => {
        setTarget(moved.pressurePercent);
        setNote({
          tone: 'info',
          text: `Compaction target set to ${moved.pressurePercent}%.`,
        });
      })
      .catch((error: unknown) => {
        setNote({
          tone: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setSaving(false));
  };

  const compactNow = () => {
    setCompacting(true);
    compactThread(usage, threadId)
      .then((result) =>
        setNote({ tone: 'info', text: compactResultMessage(result) }),
      )
      .catch((error: unknown) => {
        setNote({
          tone: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setCompacting(false));
  };

  return (
    <PopoverContent
      align="end"
      side="top"
      aria-label="Context window usage"
      className="w-72 max-w-[calc(100vw-2rem)] gap-0 border border-border bg-background p-3 pt-3 text-xs font-normal text-foreground ring-0"
    >
      <div className="flex items-baseline justify-between">
        <span className="font-medium">Context window</span>
        <span className="text-muted-foreground">
          {usedTokens === undefined || windowSize === undefined
            ? '—'
            : `${Math.round((usedTokens / windowSize) * 100)}%`}
        </span>
      </div>
      {/* The consumption bar; the range input rides it as the target slider. */}
      <div className="relative mt-2">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${usedPercent ?? 0}%` }}
          />
          {loaded && (
            <div
              className="absolute inset-y-[-2px] w-0.5 rounded bg-foreground"
              style={{ left: `${target}%` }}
            />
          )}
        </div>
        <input
          type="range"
          min={targetMin}
          max={targetMax}
          step={1}
          value={target}
          disabled={saving}
          onChange={(event) => setTarget(Number(event.target.value))}
          onPointerUp={(event) => commit(Number(event.currentTarget.value))}
          onKeyUp={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
              commit(Number(event.currentTarget.value));
          }}
          aria-label="Compaction target, as a share of the context window"
          className="relative z-10 -mt-3.5 h-4 w-full cursor-grab appearance-none bg-transparent align-middle [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-primary"
        />
      </div>
      <p className="mt-1 text-muted-foreground">
        {contextLine(usedTokens, windowSize, target)}
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="mt-2 w-full"
        disabled={compacting}
        onClick={compactNow}
      >
        {compacting ? 'Compacting…' : 'Compact now'}
      </Button>
      {note !== undefined && (
        <p
          role="status"
          className={
            note.tone === 'error'
              ? 'mt-2 text-xs text-destructive'
              : 'mt-2 text-xs text-muted-foreground'
          }
        >
          {note.text}
        </p>
      )}
    </PopoverContent>
  );
}

/** The selected Thread's context and its whole subtree's accumulated charges. */
export function ThreadUsage({
  threadId,
  usage: source,
}: {
  /** The selected Thread, when the tree describes it. */
  readonly threadId?: string;
  readonly usage?: Usage;
}) {
  const query = useThreadUsage(threadId, source);
  if (threadId === undefined) return null;
  const usage = query.data;
  const context = usage?.context;
  const total = usage?.total;
  const partial = total !== undefined && total.unpricedCalls > 0;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <ToolbarDivider />
      {source === undefined ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Context window usage">
              {contextLabel(context)}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {query.isError
              ? 'Usage could not be refreshed.'
              : 'Waiting for an OpenRouter measurement.'}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Context window usage">
              {contextLabel(context)}
            </Button>
          </PopoverTrigger>
          <ContextPopover
            usage={source}
            threadId={threadId}
            usedTokens={context?.inputTokens}
            window={context?.contextWindow}
          />
        </Popover>
      )}
      <ToolbarDivider />
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Show conversation cost breakdown"
          >
            {total === undefined ? '—' : costLabel(total)}
            {partial ? ' *' : ''}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          aria-label="Conversation cost"
          className="w-60 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border border-border bg-background p-0 pt-2.5 text-xs font-normal text-foreground ring-0"
        >
          {query.isError && (
            <p
              role="status"
              className="px-3 pb-2 text-xs text-muted-foreground"
            >
              Could not refresh costs.
            </p>
          )}
          {usage === undefined || usage.total.calls === 0 ? (
            <p className="px-3 pb-2.5 text-xs text-muted-foreground">
              No reported usage yet.
            </p>
          ) : (
            <CostBreakdown usage={usage} threadId={threadId} />
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
