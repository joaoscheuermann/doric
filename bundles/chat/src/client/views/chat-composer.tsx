import { ComposerControls } from '../components/organisms/composer-controls.js';
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
  const { canSend, send } = useComposer();
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
