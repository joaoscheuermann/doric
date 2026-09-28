import type { Thread } from '@/domain/workspace';
import { useThreadChat } from '@/hooks/use-thread-chat';
import { type FormEvent, useEffect, useRef, useState } from 'react';

/**
 * A bare stand-in for the conversation surface: a prompt input, a submit button,
 * and every event the Thread holds, verbatim. It is deliberately unstyled and
 * deliberately dumb — it exists so the rendering of prose, reasoning, tool calls
 * and comments can be built by hand on top of `useThreadChat`, which owns the
 * subscription, the log and the sending.
 *
 * `onSandboxWrite` is additive: this surface stays the bare stand-in it is
 * today and ignores it unless someone hands it over, and then it is called only
 * when the log grows a write to the sandbox the Project's Threads share.
 */
export function Conversation({
  onSandboxWrite,
  thread,
}: {
  readonly thread: Thread;
  readonly onSandboxWrite?: () => void;
}) {
  const chat = useThreadChat(thread);
  const [draft, setDraft] = useState('');
  /** The write count already reported, so a recount is not a new write. */
  const reported = useRef(chat.writes);

  useEffect(() => {
    if (chat.writes > reported.current) onSandboxWrite?.();
    reported.current = chat.writes;
  }, [chat.writes, onSandboxWrite]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void chat.prompt(draft).then((accepted) => {
      if (accepted) setDraft('');
    });
  };

  return (
    <div className="min-h-0 w-full flex-1 overflow-auto p-4">
      <form onSubmit={submit}>
        <input
          aria-label="Prompt"
          disabled={chat.sending}
          onChange={(event) => setDraft(event.target.value)}
          value={draft}
        />
        <button disabled={chat.sending} type="submit">
          Send
        </button>
      </form>
      {chat.sendError === undefined ? null : (
        <p role="alert">{chat.sendError}</p>
      )}
      {chat.error === undefined ? null : <p role="alert">{chat.error}</p>}
      <p>
        {chat.thread.name} — state {chat.thread.state} — {chat.turns.length}{' '}
        turn(s), {chat.events.length} event(s)
      </p>
      <ol>
        {chat.events.map((event) => (
          <li key={`${event.promptId}:${event.sequence}`}>
            <pre>{JSON.stringify(event, null, 2)}</pre>
          </li>
        ))}
      </ol>
    </div>
  );
}
