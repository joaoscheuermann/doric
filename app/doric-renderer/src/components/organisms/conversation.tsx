import type { Thread } from '@/domain/workspace';
import { useThreadChat } from '@/hooks/use-thread-chat';
import { type FormEvent, useState } from 'react';

/**
 * A bare stand-in for the conversation surface: a prompt input, a submit button,
 * and every event the Thread holds, verbatim. It is deliberately unstyled and
 * deliberately dumb — it exists so the rendering of prose, reasoning, tool calls
 * and comments can be built by hand on top of `useThreadChat`, which owns the
 * subscription, the log and the sending.
 */
export function Conversation({ thread }: { readonly thread: Thread }) {
  const chat = useThreadChat(thread);
  const [draft, setDraft] = useState('');

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
