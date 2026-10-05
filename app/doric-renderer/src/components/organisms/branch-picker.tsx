import { ReadFeedback } from '@/components/molecules/read-feedback';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { messageFrom, type Thread } from '@/domain/workspace';
import { useBranches } from '@/hooks/use-branches';
import { Command as CommandPrimitive } from 'cmdk';
import {
  CheckIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  SearchIcon,
} from 'lucide-react';

export function BranchPicker({
  thread,
  onSelect,
}: {
  readonly thread: Thread;
  readonly onSelect: () => void;
}) {
  const { query, mutation } = useBranches(thread);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ReadFeedback
        error={query.isError ? messageFrom(query.error) : undefined}
        refreshing={query.isFetching}
        onRetry={() => void query.refetch()}
      />
      {query.data?.status ? (
        <p role="status" className="p-2 text-sm text-muted-foreground">
          {query.data.blocked}
        </p>
      ) : query.isPending ? (
        <div className="flex flex-col gap-2 p-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <>
          <Command className="p-0">
            <div className="flex items-center gap-2 border-b px-2.5 py-1.5">
              <SearchIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <CommandPrimitive.Input asChild>
                <Input
                  autoComplete="off"
                  autoFocus
                  aria-label="Search branches"
                  className="h-6 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
                  placeholder="Search branches"
                />
              </CommandPrimitive.Input>
            </div>
            <CommandList className="max-h-none overflow-hidden">
              <ScrollArea className="[&_[data-slot=scroll-area-viewport]]:max-h-64">
                <CommandEmpty>No local branches found.</CommandEmpty>
                <CommandGroup>
                  {query.data?.branches.map((branch) => (
                    <CommandItem
                      key={branch.name}
                      value={branch.name}
                      disabled={
                        mutation.isPending ||
                        thread.state === 'running' ||
                        !!query.data?.blocked ||
                        (!branch.current && !!branch.worktree)
                      }
                      onSelect={() => {
                        if (branch.current) {
                          onSelect();
                          return;
                        }
                        mutation.mutate(branch.name, { onSuccess: onSelect });
                      }}
                    >
                      {mutation.isPending &&
                      mutation.variables === branch.name ? (
                        <LoaderCircleIcon className="animate-spin" />
                      ) : branch.current ? (
                        <CheckIcon />
                      ) : (
                        <GitBranchIcon />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate" title={branch.name}>
                          {branch.name}
                        </span>
                        <span
                          className="truncate text-xs text-muted-foreground"
                          title={branch.subject}
                        >
                          {branch.commit} · {branch.subject}
                        </span>
                        {!branch.current && branch.worktree && (
                          <span
                            className="truncate text-xs text-muted-foreground"
                            title={branch.worktree}
                          >
                            In use: {branch.worktree}
                          </span>
                        )}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </ScrollArea>
            </CommandList>
          </Command>
        </>
      )}
    </div>
  );
}
