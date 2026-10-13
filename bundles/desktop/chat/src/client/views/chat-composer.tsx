import { ComposerControls } from '../components/organisms/composer-controls.js';
import type { Thread } from '../domain/workspace.js';
import { useComposer } from '../hooks/use-composer.js';
import { useThreadStop } from '../hooks/use-thread-stop.js';
import { useSelectedThread } from '../hooks/use-workspace.js';

/**
 * `<chat-composer>`'s content (§7.6), a `layout.footer` item: the composer
 * controls for the Thread the window selects, with the rules the workspace
 * footer applied.
 */
export function ChatComposer() {
  const thread = useSelectedThread();
  return <ThreadComposer thread={thread} />;
}

/** Controls bound to the conversation's record, independent of window selection. */
export function ThreadComposer({ thread }: { readonly thread?: Thread }) {
  const { canSend, send } = useComposer(thread?.id);
  const running =
    thread?.state === 'running' && thread.activePromptId !== undefined;
  const stop = useThreadStop(thread);
  return (
    <ComposerControls
      thread={thread}
      canSend={canSend}
      disabled={thread === undefined}
      onSend={send}
      onStop={stop}
      running={running}
    />
  );
}
