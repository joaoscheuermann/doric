import { Button } from 'desktop/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'desktop/ui/collapsible';
import { ToolbarDivider } from 'desktop/ui/panels';
import { Popover, PopoverContent, PopoverTrigger } from 'desktop/ui/popover';
import { Separator } from 'desktop/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop/ui/tooltip';
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from 'lucide-react';
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

const tokenCount = (value: number | undefined) =>
  value === undefined
    ? '—'
    : new Intl.NumberFormat('en', {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value);

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
  const [breakdown, setBreakdown] = useState(false);
  const [savedTarget, setSavedTarget] = useState(targetDefault());
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
          setSavedTarget(value.pressurePercent);
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
      ? Math.min(100, Math.max(0, (usedTokens / windowSize) * 100))
      : undefined;

  const commit = (value: number) => {
    if (!loaded || saving || value === savedTarget) return;
    setSaving(true);
    writeCompactionTarget(usage, value)
      .then((moved) => {
        setTarget(moved.pressurePercent);
        setSavedTarget(moved.pressurePercent);
        setNote(undefined);
      })
      .catch((error: unknown) => {
        setTarget(savedTarget);
        setNote({
          tone: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setSaving(false));
  };

  const compactNow = () => {
    setNote(undefined);
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
      className="w-60 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border border-border bg-background p-0 text-xs font-normal text-foreground ring-0"
    >
      <div className="px-3 py-2.5">
        <p className="text-muted-foreground">Context Window</p>
        <div className="relative mt-1 flex h-5 items-center">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${usedPercent ?? 0}%` }}
            />
          </div>
          {/* Map the allowed 50–95% range onto that part of the full bar.
            Half a thumb width at either end keeps its center exact. */}
          <input
            type="range"
            min={targetMin}
            max={targetMax}
            step={1}
            value={target}
            disabled={!loaded || saving}
            onChange={(event) => setTarget(Number(event.target.value))}
            onPointerUp={(event) => commit(Number(event.currentTarget.value))}
            onKeyUp={(event) => {
              if (
                [
                  'ArrowLeft',
                  'ArrowRight',
                  'ArrowUp',
                  'ArrowDown',
                  'Home',
                  'End',
                  'PageUp',
                  'PageDown',
                ].includes(event.key)
              )
                commit(Number(event.currentTarget.value));
            }}
            onBlur={(event) => commit(Number(event.currentTarget.value))}
            aria-label="Compaction target, as a share of the context window"
            aria-valuetext={`${target}%${windowSize === undefined ? '' : `, ${tokenCount((windowSize * target) / 100)} tokens`}`}
            title={`Compact at ${target}%`}
            style={{
              left: `calc(${targetMin}% - 1.5px)`,
              width: `calc(${targetMax - targetMin}% + 3px)`,
            }}
            className="absolute m-0 h-5 cursor-ew-resize appearance-none bg-transparent p-0 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-[3px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-foreground [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-[3px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-foreground"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] leading-4 tabular-nums">
          <span>
            {tokenCount(usedTokens)}{' '}
            <span className="text-muted-foreground">
              / {tokenCount(windowSize)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Compact at{' '}
            <span className="text-foreground">
              {loaded
                ? windowSize === undefined
                  ? `${target}%`
                  : tokenCount((windowSize * target) / 100)
                : '—'}
            </span>
          </span>
        </div>
      </div>
      <Separator />
      <Collapsible open={breakdown} onOpenChange={setBreakdown}>
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className="h-7 w-full justify-start gap-1 rounded-none px-3 font-normal"
            />
          }
        >
          Context Breakdown
          {breakdown ? (
            <ChevronsDownUpIcon data-icon="inline-end" />
          ) : (
            <ChevronsUpDownIcon data-icon="inline-end" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="flex flex-col gap-1 bg-muted/40 px-3 py-2 text-[11px] leading-4 tabular-nums">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Used context</dt>
              <dd>{tokenCount(usedTokens)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Available space</dt>
              <dd>
                {tokenCount(
                  windowSize === undefined || usedTokens === undefined
                    ? undefined
                    : Math.max(0, windowSize - usedTokens),
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Context window</dt>
              <dd>{tokenCount(windowSize)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Compaction threshold</dt>
              <dd>{loaded ? `${target}%` : '—'}</dd>
            </div>
          </dl>
        </CollapsibleContent>
      </Collapsible>
      <Button
        variant="ghost"
        size="xs"
        className="h-7 w-full justify-start rounded-none px-3 font-normal"
        disabled={compacting}
        onClick={compactNow}
      >
        {compacting ? 'Compacting…' : 'Compact Now'}
      </Button>
      {note !== undefined && (
        <p
          role="status"
          className={
            note.tone === 'error'
              ? 'px-3 pb-2 pt-1 text-[11px] leading-4 text-destructive'
              : 'px-3 pb-2 pt-1 text-[11px] leading-4 text-muted-foreground'
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
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label="Context window usage"
              />
            }
          >
            {contextLabel(context)}
          </TooltipTrigger>
          <TooltipContent>
            {query.isError
              ? 'Usage could not be refreshed.'
              : 'Waiting for an OpenRouter measurement.'}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label="Context window usage"
              />
            }
          >
            {contextLabel(context)}
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
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label="Show conversation cost breakdown"
            />
          }
        >
          {total === undefined ? '—' : costLabel(total)}
          {partial ? ' *' : ''}
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
