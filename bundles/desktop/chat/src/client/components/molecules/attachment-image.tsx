import { useContext, useEffect, useState } from 'react';

import { attachmentsApi } from '../../api/attachments-api.js';
import { ConversationThreadContext } from '../../hooks/use-live-terminal.js';

type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'missing' };

/**
 * An attachment's image, as wide as the column at most and never wider than
 * itself, read through the conversation's Thread. One the Project does not
 * hold, or that cannot be read, stays its name, quietly.
 */
export function AttachmentImage({
  id,
  name,
}: {
  readonly id: string;
  readonly name: string;
}) {
  const thread = useContext(ConversationThreadContext);
  const threadId = thread?.threadId;
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

  useEffect(() => {
    if (threadId === undefined) {
      setLoaded({ status: 'missing' });
      return;
    }
    let current = true;
    setLoaded({ status: 'loading' });
    attachmentsApi
      .imageUrl(threadId, id)
      .then((url) => {
        if (current)
          setLoaded(
            url === undefined
              ? { status: 'missing' }
              : { status: 'ready', url },
          );
      })
      .catch(() => {
        if (current) setLoaded({ status: 'missing' });
      });
    return () => {
      current = false;
    };
  }, [threadId, id]);

  if (loaded.status === 'ready')
    return (
      <img
        src={loaded.url}
        alt={name}
        draggable={false}
        className="block h-auto max-w-full select-none"
      />
    );

  return (
    <span
      className="inline-block select-none text-muted-foreground"
      aria-busy={loaded.status === 'loading'}
    >
      [{name}]
    </span>
  );
}
