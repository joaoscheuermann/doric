import { ToolbarDivider } from '@/components/molecules/toolbar-divider';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
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
          className="w-96 max-w-[calc(100vw-2rem)]"
        >
          <PopoverHeader>
            <PopoverTitle>Conversation cost</PopoverTitle>
            <PopoverDescription>
              OpenRouter unified · this thread and all descendants
            </PopoverDescription>
          </PopoverHeader>
          {query.isError && (
            <p role="status">
              Could not refresh usage. Displayed values may be outdated.
            </p>
          )}
          {total === undefined || total.calls === 0 ? (
            <p>No reported usage yet.</p>
          ) : (
            <>
              <div className="flex justify-between gap-2">
                <span>Total</span>
                <strong>{costLabel(total)}</strong>
              </div>
              <div className="max-h-64 overflow-y-auto">
                <ul className="flex flex-col gap-2">
                  {usage?.threads
                    .filter((entry) => entry.calls > 0)
                    .map((entry) => (
                      <li
                        key={entry.threadId}
                        className="flex flex-col gap-0.5"
                      >
                        <div className="flex justify-between gap-3">
                          <span className="truncate" title={entry.name}>
                            {entry.name}
                            {entry.threadId === thread.id
                              ? ' (this thread)'
                              : ''}
                          </span>
                          <span className="shrink-0">
                            {costLabel(entry)}
                            {entry.unpricedCalls > 0 ? ' *' : ''}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {entry.calls} calls ·{' '}
                          {entry.inputTokens.toLocaleString('en')} input ·{' '}
                          {entry.outputTokens.toLocaleString('en')} output
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {entry.cachedInputTokens.toLocaleString('en')} cached
                          · {entry.reasoningTokens.toLocaleString('en')}{' '}
                          reasoning tokens
                        </p>
                      </li>
                    ))}
                </ul>
              </div>
              <p className="text-xs text-muted-foreground">
                Sum of reported account charges in USD. Updates after each call;
                rewinding keeps previous charges.
              </p>
              {partial && (
                <p role="status" className="text-xs text-muted-foreground">
                  * Partial: {total.unpricedCalls} calls have no reported cost
                  yet, including calls still running or interrupted.
                </p>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
