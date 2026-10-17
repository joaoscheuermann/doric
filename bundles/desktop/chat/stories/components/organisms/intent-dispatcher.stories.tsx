// A card inside the conversation emits `chat:intent`; the dispatcher runs it
// as `commands/v1.execute(command, input)` and shows a failure as a toast. The
// stories hand it story services whose `commands/v1` records each run (or
// refuses it), and draw the card a projector would.

import { Button } from 'desktop/ui/button';
import { Toaster } from 'desktop/ui/sonner';
import { ExternalLinkIcon, RocketIcon } from 'lucide-react';
import { type MouseEvent, useMemo, useState } from 'react';

import { IntentDispatcher } from '../../../src/client/components/organisms/intent-dispatcher.js';
import {
  CHAT_INTENT_EVENT,
  type ChatIntentDetail,
} from '../../../src/contracts/index.js';
import { storyServices } from '../../support/chat-host.js';

const intent =
  (detail: ChatIntentDetail) => (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.dispatchEvent(
      new CustomEvent(CHAT_INTENT_EVENT, { detail, bubbles: true }),
    );
  };

/** The card another bundle's projector draws for a deploy preview. */
function PreviewCard() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <RocketIcon className="size-4" aria-hidden="true" />
        Preview ready · storefront-pr-118
      </div>
      <p className="text-muted-foreground">
        Built from 5b0265d1 in 48s. The checkout uses the new primary token.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={intent({
            command: 'deploy.open-preview/v1',
            input: { url: 'https://storefront-pr-118.preview.example.com' },
          })}
        >
          <ExternalLinkIcon data-icon="inline-start" />
          Open preview
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={intent({
            command: 'deploy.promote/v1',
            input: { preview: 'storefront-pr-118' },
          })}
        >
          Promote to production
        </Button>
      </div>
    </div>
  );
}

function Dispatcher({ refuse = false }: { readonly refuse?: boolean }) {
  const [runs, setRuns] = useState<readonly ChatIntentDetail[]>([]);
  const services = useMemo(
    () =>
      storyServices({
        'commands/v1': {
          register: () => ({ dispose: () => undefined }),
          execute: (command: string, input?: unknown) => {
            if (refuse)
              return Promise.reject(
                new Error(
                  'Promoting needs the deploy bundle, which is not enabled.',
                ),
              );
            setRuns((previous) => [...previous, { command, input }]);
            return Promise.resolve();
          },
        },
      }),
    [refuse],
  );
  return (
    <div className="flex flex-col gap-4">
      <IntentDispatcher services={services}>
        <PreviewCard />
      </IntentDispatcher>
      <ol className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
        {runs.length === 0 ? (
          <li>No command ran yet.</li>
        ) : (
          runs.map((run, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log
            <li key={index}>
              commands/v1.execute({run.command}, {JSON.stringify(run.input)})
            </li>
          ))
        )}
      </ol>
      <Toaster />
    </div>
  );
}

export default {
  title: 'Chat/Organisms/Intent dispatcher',
  component: IntentDispatcher,
};

export const RunsIntents = {
  render: () => <Dispatcher />,
};

/** A command that fails becomes a toast with its message. */
export const RefusedCommand = {
  render: () => <Dispatcher refuse />,
};
