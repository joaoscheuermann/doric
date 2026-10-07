import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { NodeKey } from 'lexical';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useStore } from 'zustand/react';

import { PromptAuthor } from '@/components/molecules/prompt-author';
import { EDIT_QUEUE_PROMPT_COMMAND } from '@/components/organisms/conversation/commands';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import {
  type QueueItem,
  queueAuthor,
  queueDetail,
  queueItems,
  visibleQueueItems,
} from '@/domain/queue';
import { useQueueCaret } from '@/hooks/use-queue-caret';
import { useThreadQueue } from '@/hooks/use-thread-queue';
import { queueEditStore } from '@/stores/queue-edit';
import { threadChatsStore } from '@/stores/thread-chats';
import { cn } from '@/utility/utils';

function Details({
  item,
  threadId,
}: {
  readonly item: QueueItem;
  readonly threadId: string;
}) {
  const text = useStore(threadChatsStore, (state) =>
    queueDetail(
      state.chats.chats.get(threadId)?.projection.events ?? [],
      item.promptId,
    ),
  );
  return (
    <>
      <div className="max-h-64 overflow-y-auto p-4 whitespace-pre-wrap wrap-break-word select-text">
        {text ?? item.preview}
      </div>
      <Separator />
      <footer
        className="flex items-center gap-1.5 bg-sidebar px-4 py-3 text-xs text-muted-foreground [&>svg]:size-4.5"
        title={
          item.acceptedAt
            ? new Date(item.acceptedAt).toLocaleString()
            : undefined
        }
      >
        <PromptAuthor source={item.source} label={item.label} />
      </footer>
    </>
  );
}

function Item({
  item,
  threadId,
  focused,
  editing,
  onFocus,
  onKeyDown,
}: {
  readonly item: QueueItem;
  readonly threadId: string;
  readonly focused: boolean;
  readonly editing: boolean;
  readonly onFocus: () => void;
  readonly onKeyDown: (event: KeyboardEvent) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);
  return (
    <li className="min-w-0">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            ref={ref}
            variant="ghost"
            size="sm"
            data-queue-id={item.promptId}
            data-caret={focused || undefined}
            data-editing={editing || undefined}
            className={cn(
              'queue-row w-full justify-start gap-2 rounded-none border-0 text-sm font-light focus-visible:ring-inset has-data-[icon=inline-start]:pl-2.5',
              focused && 'bg-muted',
            )}
            aria-label={`${queueAuthor(item.source, item.label)}: ${item.preview}`}
            onFocus={onFocus}
            onKeyDown={onKeyDown}
          >
            <PromptAuthor source={item.source} label={item.label} />
            <span className="min-w-0 truncate text-muted-foreground">
              {item.preview}
            </span>
            {editing && (
              <span className="ml-auto shrink-0 pl-3 text-xs font-normal text-muted-foreground">
                Editing
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          aria-label={`Queued prompt from ${queueAuthor(item.source, item.label)}`}
          className="w-96 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border border-border bg-background p-0 font-conversation text-foreground ring-0 duration-0"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Details item={item} threadId={threadId} />
        </PopoverContent>
      </Popover>
    </li>
  );
}

/** One live queue attached to the draft, with an individual caret stop per input. */
export function ThreadQueue({
  threadId,
  nodeKey,
  focusedId,
}: {
  readonly threadId: string;
  readonly nodeKey: NodeKey;
  readonly focusedId?: string;
}) {
  const [editor] = useLexicalComposerContext();
  const editingId = useStore(
    queueEditStore,
    (state) => state.edits[threadId]?.item.promptId,
  );
  const query = useThreadQueue(threadId);
  const queue = query.data;
  const ids = useMemo(
    () => visibleQueueItems(queue).map((item) => item.promptId),
    [queue],
  );
  const remove = useCallback(
    (id: string) => {
      if (!query.removing) query.remove(id);
    },
    [query.removing, query.remove],
  );
  const edit = useCallback(
    (id: string) => {
      const item = queueItems(queue).find((item) => item.promptId === id);
      return (
        item !== undefined &&
        editor.dispatchCommand(EDIT_QUEUE_PROMPT_COMMAND, item)
      );
    },
    [editor, queue],
  );
  const caret = useQueueCaret(nodeKey, ids, remove, edit);
  if (queue === undefined)
    return query.isError ? (
      <div
        role="status"
        className="mb-4 flex items-center gap-2 font-conversation text-xs text-muted-foreground"
      >
        Queue unavailable{' '}
        <Button
          variant="ghost"
          size="xs"
          className="px-0 font-light"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    ) : null;
  if (ids.length === 0 && queue.error === undefined) return null;
  const current = queue.current ?? queue.resumable;
  const row = (item: QueueItem) => (
    <Item
      key={item.promptId}
      item={item}
      threadId={threadId}
      focused={caret.selected && focusedId === item.promptId}
      editing={editingId === item.promptId}
      onFocus={() => caret.focus(item.promptId)}
      onKeyDown={(event) => caret.keyDown(item.promptId, event)}
    />
  );
  return (
    <section
      aria-label="Prompt queue"
      className="mb-5 flex flex-col gap-2 font-conversation text-sm font-light"
    >
      <h2 className="text-sm font-light text-foreground">Queue</h2>
      {queue.error && (
        <Alert variant="destructive">
          <AlertTitle>Execution paused</AlertTitle>
          <AlertDescription>{queue.error.message}</AlertDescription>
        </Alert>
      )}
      {query.isError && (
        <p role="status" className="text-xs text-muted-foreground">
          Could not refresh queue.
        </p>
      )}
      {current && (
        <div className="flex flex-col gap-0.5">
          <h3 className="text-xs font-light text-muted-foreground">Current:</h3>
          <ol className="-mx-2.5">{row(current)}</ol>
        </div>
      )}
      {queue.items.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <h3 className="text-xs font-light text-muted-foreground">Next:</h3>
          <ol className="-mx-2.5 flex max-h-48 flex-col gap-0.5 overflow-y-auto">
            {queue.items.map(row)}
          </ol>
        </div>
      )}
    </section>
  );
}
