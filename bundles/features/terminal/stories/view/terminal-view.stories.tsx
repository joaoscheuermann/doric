import { type ReactNode, useState } from 'react';

import type { Terminal } from '../../src/client/domain/terminals.js';
import { TerminalView } from '../../src/client/view/terminal-view.js';
import {
  devServer,
  longOutput,
  startingBuild,
  testRun,
  userShell,
} from '../support/fixtures.js';
import {
  type StoryWatch,
  storyTerminalApi,
  storyWatches,
} from '../support/terminal-client.js';

/** A workspace tab's frame: the tab area beside the conversation. */
function TabFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border" style={{ height: 420 }}>
      {children}
    </div>
  );
}

/** One terminal's emulator over seeded output watches. */
function ViewStory({
  session,
  watch,
  showHeader,
  closable = false,
}: {
  readonly session: Terminal;
  readonly watch?: StoryWatch;
  readonly showHeader?: boolean;
  readonly closable?: boolean;
}) {
  const [{ api, watches }] = useState(() => ({
    api: storyTerminalApi(),
    watches: storyWatches(watch === undefined ? {} : { [session.id]: watch }),
  }));
  return (
    <TabFrame>
      <TerminalView
        api={api}
        watches={watches}
        session={session}
        showHeader={showHeader}
        onClose={closable ? () => undefined : undefined}
      />
    </TabFrame>
  );
}

export default {
  title: 'Terminal/View/Terminal view',
  component: TerminalView,
};

export const DevServer = {
  render: () => <ViewStory session={devServer} closable />,
};

/** Output that keeps arriving for a few seconds after the snapshot. */
export const LiveOutput = {
  render: () => (
    <ViewStory
      session={devServer}
      watch={{
        chunks: [
          '\u001b[2m8:03:02 AM\u001b[0m \u001b[36m\u001b[1m[vite]\u001b[0m \u001b[32mhmr update\u001b[0m \u001b[2m/src/checkout/payment-form.tsx\u001b[0m\n',
          '\u001b[2m8:03:05 AM\u001b[0m \u001b[36m\u001b[1m[vite]\u001b[0m \u001b[32mpage reload\u001b[0m \u001b[2msrc/main.tsx\u001b[0m\n',
          '\u001b[2m8:03:09 AM\u001b[0m \u001b[33m\u001b[1m[vite]\u001b[0m \u001b[33mwarning:\u001b[0m unused import "formatTotal" in shipping-step.tsx\n',
        ],
        intervalMs: 900,
      }}
    />
  ),
};

export const ExitedWithFailures = {
  render: () => <ViewStory session={testRun} closable />,
};

export const UserShell = {
  render: () => <ViewStory session={userShell} closable />,
};

/** The snapshot lost its start: the emulator says so before the rest. */
export const TruncatedScrollback = {
  render: () => (
    <ViewStory
      session={startingBuild}
      watch={{ snapshot: longOutput, truncated: true }}
    />
  ),
};

export const LongCommand = {
  render: () => <ViewStory session={startingBuild} closable />,
};

/** In the bottom split, which draws its own header. */
export const WithoutHeader = {
  render: () => <ViewStory session={devServer} showHeader={false} />,
};

export const WatchFailed = {
  render: () => (
    <ViewStory
      session={devServer}
      watch={{ error: 'The terminal is no longer available.' }}
      closable
    />
  ),
};

export const EmptyOutput = {
  render: () => (
    <ViewStory
      session={{ ...startingBuild, command: 'sleep 30' }}
      watch={{ snapshot: '' }}
    />
  ),
};
