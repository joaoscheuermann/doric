import { CostBreakdown } from '@/components/molecules/cost-breakdown';
import { ToolbarDivider } from '@/components/molecules/toolbar-divider';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { contextLabel, costLabel } from '@/domain/usage';
import type { Thread } from '@/domain/workspace';
import { useThreadUsage } from '@/hooks/use-thread-usage';

/** The selected Thread's context and its whole subtree's accumulated charges. */
export function ThreadUsage({ thread }: { readonly thread?: Thread }) {
  const query = useThreadUsage(thread);
  if (thread === undefined) return null;
  const usage = query.data;
  const context = usage?.context;
  const total = usage?.total;
  const partial = total !== undefined && total.unpricedCalls > 0;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <ToolbarDivider />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Context window usage">
            {contextLabel(context)}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {query.isError
            ? 'Usage could not be refreshed.'
            : context === undefined
              ? 'Waiting for an OpenRouter unified measurement.'
              : `${context.model}: last reported input tokens. ${context.contextWindow === undefined ? 'Window size unavailable.' : context.contextWindowSource === 'catalog' ? 'Capacity from the current OpenRouter catalog.' : 'Capacity advertised by OpenRouter at execution time.'}`}
        </TooltipContent>
      </Tooltip>
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
            <CostBreakdown usage={usage} threadId={thread.id} />
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
