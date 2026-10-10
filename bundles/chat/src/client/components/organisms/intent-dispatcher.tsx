import { CommandsV1, type ContractId, type Services } from 'bundle/contracts';
import { toast } from 'desktop-ui/sonner';
import { type ReactNode, useEffect, useRef } from 'react';

import {
  CHAT_INTENT_EVENT,
  type ChatIntentDetail,
} from '../../../contracts/index.js';
import { messageFrom } from '../../domain/errors.js';

const isIntent = (detail: unknown): detail is ChatIntentDetail =>
  typeof detail === 'object' &&
  detail !== null &&
  typeof (detail as { command?: unknown }).command === 'string';

/**
 * Runs the intents the conversation's cards emit (§7.7): a `chat:intent`
 * event from anywhere inside becomes `commands/v1.execute(command, input)`,
 * and a failure is a toast with its message. The frame is `display: contents`,
 * so it adds no box and no role.
 */
export function IntentDispatcher({
  services,
  children,
}: {
  readonly services: Services;
  readonly children?: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isIntent(detail)) return;
      event.stopPropagation();
      // A malformed id is the command service's to refuse, with its message.
      let running: Promise<void>;
      try {
        running = services
          .use(CommandsV1)
          .execute(detail.command as ContractId, detail.input);
      } catch (error) {
        toast.error(messageFrom(error));
        return;
      }
      running.catch((error: unknown) => toast.error(messageFrom(error)));
    };
    element.addEventListener(CHAT_INTENT_EVENT, listener);
    return () => element.removeEventListener(CHAT_INTENT_EVENT, listener);
  }, [services]);

  return (
    <div ref={frame} className="contents">
      {children}
    </div>
  );
}
