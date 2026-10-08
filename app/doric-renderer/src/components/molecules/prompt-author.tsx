import { BotIcon, TerminalIcon } from 'lucide-react';

import { ReaderAvatar } from '@/components/molecules/reader-avatar';
import { type QueueItem, queueAuthor } from '@/domain/queue';

/** The same compact identity in a queued receipt and the live input queue. */
export function PromptAuthor({
  source,
  label,
}: {
  readonly source: QueueItem['source'];
  readonly label?: string;
}) {
  const name = queueAuthor(source, label);
  const Icon = source.kind === 'terminal' ? TerminalIcon : BotIcon;
  return (
    <>
      {source.kind === 'user' ? (
        <ReaderAvatar name={name} />
      ) : (
        <Icon data-icon="inline-start" />
      )}
      <span className="max-w-40 shrink-0 truncate">{name}</span>
    </>
  );
}
