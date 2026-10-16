import type { QueryClient } from '@tanstack/react-query';

import { ThreadUsage } from '../../src/client/components/thread-usage.js';
import { usageMessages, usageQueryKey } from '../../src/client/domain/read.js';
import type {
  ThreadUsage as ThreadUsageValue,
  Usage,
} from '../../src/contracts/index.js';
import { footerDecorator } from '../support/footer.js';
import { OpenOnMount, WithQueryClient } from '../support/query.js';
import {
  currentThread,
  emptyUsage,
  fixtureUsage,
  partiallyPricedUsage,
  sonnetContext,
  subthreads,
  threadId,
  threadUsage,
} from '../support/usage.js';

const contextTrigger = 'button[aria-label="Context window usage"]';
const costTrigger = 'button[aria-label="Show conversation cost breakdown"]';

/** The last usage the footer read, in the cache under the Thread's key. */
const seedUsage = (client: QueryClient, usage: ThreadUsageValue) =>
  client.setQueryData(usageQueryKey(threadId), usage);

/** The read failed after it had a value: the value stays, the error shows. */
const seedRefreshFailure = (client: QueryClient, usage: ThreadUsageValue) => {
  seedUsage(client, usage);
  const query = client.getQueryCache().find({
    queryKey: usageQueryKey(threadId),
  });
  query?.setState({
    ...query.state,
    status: 'error',
    error: new Error(usageMessages.failed),
    errorUpdateCount: 1,
    errorUpdatedAt: Date.now(),
    fetchFailureCount: 3,
  });
};

function Footer({
  usage = threadUsage(),
  source = fixtureUsage({ usage: () => usage }),
  seed = (client) => seedUsage(client, usage),
  open,
}: {
  readonly usage?: ThreadUsageValue;
  readonly source?: Usage | null;
  readonly seed?: (client: QueryClient) => void;
  readonly open?: string;
}) {
  const view = <ThreadUsage threadId={threadId} usage={source ?? undefined} />;
  return (
    <WithQueryClient seed={seed}>
      {open === undefined ? (
        view
      ) : (
        <OpenOnMount selector={open}>{view}</OpenOnMount>
      )}
    </WithQueryClient>
  );
}

export default {
  title: 'Usage/Components/Thread usage',
  component: ThreadUsage,
  decorators: [footerDecorator],
};

export const Default = {
  render: () => <Footer />,
};

export const ContextPopoverOpen = {
  render: () => <Footer open={contextTrigger} />,
};

export const CostPopoverOpen = {
  render: () => <Footer open={costTrigger} />,
};

export const NearCompactionTarget = {
  render: () => (
    <Footer
      usage={threadUsage({
        context: { ...sonnetContext, inputTokens: 171_400 },
      })}
      open={contextTrigger}
    />
  ),
};

export const UnknownContextWindow = {
  render: () => (
    <Footer
      usage={threadUsage({
        context: {
          model: 'acme/local-coder',
          inputTokens: 38_900,
        },
      })}
      open={contextTrigger}
    />
  ),
};

export const PartialCost = {
  render: () => <Footer usage={partiallyPricedUsage()} open={costTrigger} />,
};

export const SubCentCost = {
  render: () => (
    <Footer
      usage={threadUsage({
        threads: [{ ...subthreads[2], threadId, name: currentThread.name }],
        context: { ...sonnetContext, inputTokens: 9_400 },
      })}
    />
  ),
};

export const NoUsageYet = {
  render: () => <Footer usage={emptyUsage()} open={costTrigger} />,
};

export const WaitingForMeasurement = {
  render: () => <Footer source={null} seed={() => undefined} />,
};

export const RefreshFailed = {
  render: () => (
    <Footer
      source={fixtureUsage({
        thread: () => Promise.reject(new Error('disconnected')),
      })}
      seed={(client) => seedRefreshFailure(client, threadUsage())}
      open={costTrigger}
    />
  ),
};

export const CompactionSettingsUnreadable = {
  render: () => (
    <Footer
      source={fixtureUsage({
        compactionTarget: () => Promise.reject(new Error('unavailable')),
      })}
      open={contextTrigger}
    />
  ),
};

export const CompactionRefused = {
  render: () => (
    <Footer
      source={fixtureUsage({
        compact: { status: 'refused', reason: 'nothing_to_compact' },
      })}
      open={contextTrigger}
    />
  ),
};
