// The rail measures the conversation's scroll view, so each story draws one: a
// `conversation-scroll` area whose blocks carry the transcript's own data
// attributes (`data-prompt-id`, `data-result-prompt-id`,
// `data-queued-prompt-id`, `data-prompt-input`), each with the words its turn
// holds, and the rail inside it over the projected turns of a fixture Thread.

import { ScrollArea } from 'desktop/ui/scroll-area';
import { useEffect, useMemo, useRef } from 'react';

import { ThreadNavRail } from '../../../src/client/components/molecules/thread-nav-rail.js';
import type { Turn } from '../../../src/client/domain/projector.js';
import { installChatHost } from '../../support/chat-host.js';
import { threadIds, turnsOf } from '../../support/fixtures.js';

const answer =
  'I read the component, changed the class to the theme token and ran the checkout tests again; all of them pass.';

function Block({ turn }: { readonly turn: Turn }) {
  if (turn.type === 'queued')
    return (
      <div
        data-queued-prompt-id={turn.promptId}
        className="text-muted-foreground"
      >
        Queued · {turn.items.map((item) => item.text).join(' · ')}
      </div>
    );
  if (turn.type === 'user')
    return (
      <div
        data-prompt-id={turn.promptId}
        {...(turn.delegated?.kind === 'result'
          ? { 'data-result-prompt-id': turn.promptId }
          : {})}
        className="rounded-md border border-border bg-card px-3 py-2"
      >
        {turn.delegated?.text ?? turn.text}
      </div>
    );
  if (turn.type === 'agent')
    return (
      <div className="flex flex-col gap-3">
        <p>{turn.text}</p>
        <p>{answer}</p>
        <p>{answer}</p>
      </div>
    );
  return null;
}

function Rail({
  turns,
  previewIndex,
}: {
  readonly turns: readonly Turn[];
  /** The handle whose preview opens, as the caret resting on it opens it. */
  readonly previewIndex?: number;
}) {
  installChatHost();
  const scrollRoot = useRef<HTMLDivElement | null>(null);
  const navigating = useRef(false);
  const following = useRef(false);
  useEffect(() => {
    if (previewIndex === undefined) return;
    scrollRoot.current
      ?.querySelectorAll<HTMLButtonElement>('nav button')
      [previewIndex]?.focus();
  }, [previewIndex]);
  return (
    <div className="flex h-[480px] min-h-0 overflow-hidden rounded-lg border bg-background">
      <ScrollArea
        ref={scrollRoot}
        className="conversation-scroll min-h-0 w-full flex-1"
      >
        <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pt-6 pb-40 font-conversation text-sm font-light">
          {turns.map((turn, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixture turns are static
            <Block key={index} turn={turn} />
          ))}
          <div data-prompt-input="" className="text-muted-foreground">
            Ask the agent to search, edit or build in this project…
          </div>
        </div>
        <ThreadNavRail
          turns={turns}
          scrollRoot={scrollRoot}
          navigating={navigating}
          following={following}
        />
      </ScrollArea>
    </div>
  );
}

function Fixture({
  threads,
  previewIndex,
}: {
  readonly threads: readonly string[];
  readonly previewIndex?: number;
}) {
  const turns = useMemo(() => threads.flatMap(turnsOf), [threads]);
  return <Rail turns={turns} previewIndex={previewIndex} />;
}

export default {
  title: 'Chat/Molecules/Thread nav rail',
  component: ThreadNavRail,
};

export const Prompts = {
  render: () => <Fixture threads={[threadIds.conversation]} />,
};

export const QueuedReceipts = {
  render: () => <Fixture threads={[threadIds.queued]} />,
};

export const SubthreadResult = {
  render: () => <Fixture threads={[threadIds.delegated]} />,
};

export const PreviewOpen = {
  render: () => <Fixture threads={[threadIds.conversation]} previewIndex={0} />,
};

export const ResultPreviewOpen = {
  render: () => <Fixture threads={[threadIds.delegated]} previewIndex={1} />,
};

export const ManyHandles = {
  render: () => (
    <Fixture
      threads={[
        threadIds.conversation,
        threadIds.running,
        threadIds.comments,
        threadIds.delegated,
        threadIds.queued,
      ]}
    />
  ),
};

export const EmptyThread = {
  render: () => <Fixture threads={[threadIds.empty]} />,
};
