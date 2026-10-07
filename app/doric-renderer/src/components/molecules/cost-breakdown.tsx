import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  costLabel,
  type ThreadUsage,
  type UsageTotals,
  usageBreakdown,
  usageLabels,
} from '@/domain/usage';

function Cost({ total }: { readonly total: UsageTotals }) {
  const partial = total.unpricedCalls > 0;
  const note = partial
    ? `Partial: ${total.unpricedCalls} calls have no reported cost yet.`
    : undefined;
  return (
    <span className="shrink-0 tabular-nums" title={note}>
      {costLabel(total)}
      {partial ? ' *' : ''}
      {note && <span className="sr-only"> {note}</span>}
    </span>
  );
}

function TokenCount({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex items-center gap-0.5">
          <Icon aria-hidden="true" className="size-3" />
          <span className="sr-only">{label}: </span>
          {value}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Metrics({ total }: { readonly total: UsageTotals }) {
  const labels = usageLabels(total);
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-muted-foreground tabular-nums">
      <span>{labels.calls}</span>
      <span aria-hidden="true">·</span>
      <TokenCount
        icon={ArrowDownLeftIcon}
        label="Input tokens"
        value={labels.input}
      />
      <TokenCount
        icon={ArrowUpRightIcon}
        label="Output tokens"
        value={labels.output}
      />
    </p>
  );
}

function Row({
  divider = false,
  label,
  total,
}: {
  readonly divider?: boolean;
  readonly label: string;
  readonly total: UsageTotals;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-normal" title={label}>
          {label}
        </span>
        {divider && <Separator className="min-w-0 flex-1" />}
        <Cost total={total} />
      </div>
      <Metrics total={total} />
    </div>
  );
}

/** Compact own/subtree accounting; individual descendants are an optional detail. */
export function CostBreakdown({
  usage,
  threadId,
}: {
  readonly usage: ThreadUsage;
  readonly threadId: string;
}) {
  const { current, subthreads, subtotal } = usageBreakdown(usage, threadId);
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <div className="px-3">
          <Row divider label="Current Thread" total={current} />
        </div>
        <Collapsible key={threadId}>
          <div className="flex flex-col gap-0.5 px-3 pb-2.5">
            <div className="flex items-center justify-between gap-2">
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  className="group -ml-1 h-auto px-1 py-0 font-normal"
                  disabled={subthreads.length === 0}
                >
                  Sub Threads
                  <ChevronsUpDownIcon
                    aria-hidden="true"
                    data-icon="inline-end"
                    className="group-data-[state=open]:hidden"
                  />
                  <ChevronsDownUpIcon
                    aria-hidden="true"
                    data-icon="inline-end"
                    className="hidden group-data-[state=open]:block"
                  />
                </Button>
              </CollapsibleTrigger>
              <Separator className="min-w-0 flex-1" />
              <Cost total={subtotal} />
            </div>
            <Metrics total={subtotal} />
          </div>
          <CollapsibleContent className="border-t border-border bg-muted/40">
            <ul className="flex flex-col">
              {subthreads.map((entry) => (
                <li
                  key={entry.threadId}
                  className="min-w-0 px-3 py-1 text-[11px] first:pt-2 last:pb-2 [&_p]:text-[10px]"
                >
                  <Row label={entry.name} total={entry} />
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <Separator />
      <footer className="flex items-center justify-between gap-2 bg-sidebar px-3 py-2">
        <span>Total</span>
        <Cost total={usage.total} />
      </footer>
    </>
  );
}
