// The `threads-spawn-call` element (bundle isolation 5(b), change 3): the
// block a `thread-spawn` call draws in the transcript, moved from the chat's
// `components/organisms/conversation/nodes/thread-spawn-node.tsx` and
// registered through `chat.views/v1`. The chat creates one element per call
// and sets its `view`; the element draws the block from it and reports the
// reader's open/close choice with `chat-block-chosen`.
//
// The block is shaped like the delegated "Result from:" block: the call hands
// a task to a Thread of its own, and once the child exists its header names
// it. It is open while the call spawns, folded once the child exists, and
// open again when the call failed (`spawnOpenness`).

import type { Services } from 'bundle/contracts';
import type { ErrorCatalog, ErrorInfo } from 'desktop/reads';
import { Button } from 'desktop/ui/button';
import {
  blockOpen,
  type Chosen,
  CollapsibleBlock,
  type Openness,
} from 'desktop/ui/collapsible-block';
import { ErrorNotice } from 'desktop/ui/error-notice';
import { defineReactElement } from 'desktop/ui/react-element';
import { memo, useCallback, useMemo, useRef } from 'react';

import { CHAT_BLOCK_CHOSEN_EVENT, type ChatToolView } from './chat-contract.js';
import { ReadonlyMarkdown } from './delegated-turn.js';
import { parseThreadSpawn, THREAD_SPAWN_TOOL } from './domain/thread-spawn.js';
import { useDelegatedSource } from './source.js';

/** The tag `threads` defines through `ui/v1` and registers for `thread-spawn`. */
export const SPAWN_CALL_TAG = 'threads-spawn-call';

/** Where a call is: running, or settled one way or the other. */
type ToolStatus = ChatToolView['status'];

/**
 * The codes the spawn block's failure notice names beside the shared entries:
 * `tool_failed`, its fallback (OD-6).
 */
export const threadsToolCatalog: ErrorCatalog = {
  tool_failed: { title: 'Tool failed', retryable: false },
};

/**
 * When a `thread-spawn` block is open while the reader has not chosen: while
 * it spawns, the prompt handed down is what the reader sees; once the child
 * exists the header names it, so the block folds; a failed spawn is open,
 * the one outcome a reader must not scroll past.
 */
export const spawnOpenness = (status: ToolStatus): Openness => ({
  active: status === 'running',
  hasContent: true,
  defaultOpen: status !== 'finished',
});

/** The verb the block's header names the call by. */
const spawnVerb = (status: ToolStatus): string =>
  status === 'running'
    ? 'Spawning'
    : status === 'failed'
      ? 'Spawn failed'
      : 'Spawned';

/** The child the call started, named by the transcript's own words for it. */
function SpawnedLink({
  threadId,
  services,
}: {
  readonly threadId: string;
  readonly services: Services;
}) {
  const source = useDelegatedSource(threadId, services);
  return (
    <Button
      variant="link"
      size="sm"
      className="h-auto min-w-0 shrink px-0 py-0"
      title={threadId}
      onClick={source.open}
    >
      <span className="truncate">{source.label.value}</span>
    </Button>
  );
}

/**
 * The agent, model and effort the call names, muted, as the header's last words:
 * what the work is comes first, how it runs after. `className` sets the space
 * before it, which differs by the row it sits in.
 */
function SpawnMeta({
  className,
  meta,
}: {
  readonly className: string;
  readonly meta: readonly string[];
}) {
  return (
    <span
      data-slot="spawn-meta"
      className={`min-w-0 truncate font-light text-muted-foreground/70 ${className}`}
    >
      · {meta.join(' · ')}
    </span>
  );
}

type ThreadSpawnRowProps = {
  readonly args: string;
  readonly chosen: Chosen;
  readonly error: ErrorInfo | undefined;
  readonly focused: boolean;
  readonly onChosenChange: (chosen: boolean) => void;
  readonly result: string | undefined;
  readonly status: ToolStatus;
  readonly services: Services;
};

/**
 * The call as the reader meets it: the verb the call is at, the child it started
 * once the result names one, and the prompt the agent handed down — with the
 * error under it when the call failed. The header ends with the agent, model
 * and effort the call names: after the child once there is one, after the verb
 * until then.
 */
export const ThreadSpawnRow = memo(function ThreadSpawnRow({
  args,
  chosen,
  error,
  focused,
  onChosenChange,
  result,
  services,
  status,
}: ThreadSpawnRowProps) {
  const parsed = useMemo(() => parseThreadSpawn(args, result), [args, result]);
  const child = parsed.child;
  const meta = [parsed.agent, parsed.model, parsed.effort].filter(
    (value) => value !== undefined,
  );
  const verb = <span className="font-normal">{spawnVerb(status)}</span>;
  return (
    <CollapsibleBlock
      label={
        child !== undefined || meta.length === 0 ? (
          verb
        ) : (
          // A space's width before the note, as between its own words.
          <span className="flex min-w-0 items-baseline whitespace-nowrap">
            {verb} <SpawnMeta className="ml-2" meta={meta} />
          </span>
        )
      }
      action={
        child === undefined
          ? undefined
          : {
              toggleLabel: 'Toggle thread spawn',
              content: (
                <>
                  <SpawnedLink threadId={child.threadId} services={services} />
                  {/* The header's gap-1 plus ml-1: a space's width. */}
                  {meta.length === 0 ? null : (
                    <SpawnMeta className="ml-1" meta={meta} />
                  )}
                </>
              ),
            }
      }
      chosen={chosen}
      focused={focused}
      onChosenChange={onChosenChange}
      openness={spawnOpenness(status)}
    >
      <div className="flex flex-col gap-2">
        <ReadonlyMarkdown text={parsed.prompt} services={services} />
        {error === undefined ? null : (
          <ErrorNotice
            variant="compact"
            error={error}
            catalog={threadsToolCatalog}
            fallbackCode="tool_failed"
            context={{ Tool: THREAD_SPAWN_TOOL }}
          />
        )}
      </div>
    </CollapsibleBlock>
  );
});

/** Dispatches the reader's choice from `target`; it bubbles to the element. */
const dispatchChosen = (target: EventTarget, chosen: boolean): void => {
  target.dispatchEvent(
    new CustomEvent<{ readonly chosen: boolean }>(CHAT_BLOCK_CHOSEN_EVENT, {
      detail: { chosen },
      bubbles: true,
      composed: true,
    }),
  );
};

/** What the chat sets on the element. */
interface SpawnCallProps {
  readonly view?: ChatToolView;
}

/**
 * Draws the block of the element's `view` and reports the reader's choice
 * from its root, whose parent is the element: the event bubbles to the
 * element, where the chat keeps it.
 */
function SpawnCall({
  view,
  services,
}: SpawnCallProps & { readonly services: Services }) {
  const root = useRef<HTMLDivElement>(null);
  const onChosenChange = useCallback((chosen: boolean) => {
    if (root.current !== null) dispatchChosen(root.current, chosen);
  }, []);
  if (view === undefined) return null;
  return (
    <div ref={root} data-slot="thread-spawn" className="contents">
      <ThreadSpawnRow
        args={view.args}
        result={view.result}
        error={view.error}
        status={view.status}
        chosen={view.chosen}
        focused={view.focused}
        onChosenChange={onChosenChange}
        services={services}
      />
    </div>
  );
}

/**
 * The `threads-spawn-call` element class: maps `view` (`ChatToolView`) to the
 * block and dispatches `chat-block-chosen` for the reader's choice. Its
 * `toggle()` (O2) reports the opposite of what the block shows by the spawn's
 * own rule (open while spawning and when failed), which differs from the
 * chat's generic answer.
 */
export const defineSpawnCallElement = () => {
  const Base = defineReactElement<SpawnCallProps>({
    props: ['view'],
    render: SpawnCall,
  });
  return class SpawnCallElement extends Base {
    declare view: ChatToolView | undefined;

    toggle(): void {
      const view = this.view;
      if (view === undefined) return;
      dispatchChosen(this, !blockOpen(view.chosen, spawnOpenness(view.status)));
    }
  };
};
