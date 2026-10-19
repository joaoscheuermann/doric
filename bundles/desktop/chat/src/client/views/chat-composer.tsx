import { AgentThreadControls } from '../components/organisms/agent-thread-controls.js';
import { ComposerControls } from '../components/organisms/composer-controls.js';
import { agentControl } from '../domain/agent-control.js';
import { isAgentThread, type Thread } from '../domain/workspace.js';
import { useComposer } from '../hooks/use-composer.js';
import { useThreadChat } from '../hooks/use-thread-chat.js';
import { useThreadQueue } from '../hooks/use-thread-queue.js';
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

/**
 * The footer of one Thread: a reader Thread gets the composer, and an agent
 * Thread — one an agent spawned and holds — gets its three levers instead, since
 * the reader writes nothing there.
 */
export function ThreadComposer({ thread }: { readonly thread?: Thread }) {
  if (thread !== undefined && isAgentThread(thread))
    return <AgentThreadComposer thread={thread} />;
  return <ReaderThreadComposer thread={thread} />;
}

/** Controls bound to the conversation's record, independent of window selection. */
function ReaderThreadComposer({ thread }: { readonly thread?: Thread }) {
  const { canSend, send } = useComposer(thread);
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

/**
 * What an agent Thread carries where the composer would be: who runs it, and the
 * only three things the reader may do about that — pause the run, continue a
 * prompt it left unfinished, or retry the last one. Each lever reads its own
 * state from the log, so a disabled one says why.
 */
function AgentThreadComposer({ thread }: { readonly thread: Thread }) {
  const chat = useThreadChat(thread);
  const queue = useThreadQueue(thread.id);
  const control = agentControl(thread, chat.turns, queue.data);
  const stop = useThreadStop(thread);

  const continueRun = () => {
    if (control.pausedPromptId !== undefined)
      void chat.resume(control.pausedPromptId);
    else queue.resume();
  };

  const retry = () => {
    if (control.canRetry) void chat.retry();
  };

  return (
    <AgentThreadControls
      control={control}
      onContinue={continueRun}
      onPause={stop}
      onRetry={retry}
    />
  );
}
