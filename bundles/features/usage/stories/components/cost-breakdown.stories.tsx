import { CostBreakdown } from '../../src/client/components/cost-breakdown.js';
import { popoverDecorator } from '../support/footer.js';
import { OpenOnMount } from '../support/query.js';
import {
  currentThread,
  partiallyPricedUsage,
  subthreads,
  threadId,
  threadUsage,
} from '../support/usage.js';

const subThreadsTrigger = '[data-slot="collapsible-trigger"]';

export default {
  title: 'Usage/Components/Cost breakdown',
  component: CostBreakdown,
  decorators: [popoverDecorator],
};

export const Default = {
  render: () => <CostBreakdown usage={threadUsage()} threadId={threadId} />,
};

export const SubThreadsExpanded = {
  render: () => (
    <OpenOnMount selector={subThreadsTrigger}>
      <CostBreakdown usage={threadUsage()} threadId={threadId} />
    </OpenOnMount>
  ),
};

export const NoSubThreads = {
  render: () => (
    <CostBreakdown
      usage={threadUsage({ threads: [currentThread] })}
      threadId={threadId}
    />
  ),
};

export const PartialCost = {
  render: () => (
    <OpenOnMount selector={subThreadsTrigger}>
      <CostBreakdown usage={partiallyPricedUsage()} threadId={threadId} />
    </OpenOnMount>
  ),
};

export const SubCentCharges = {
  render: () => (
    <CostBreakdown
      usage={threadUsage({
        threads: [
          { ...currentThread, calls: 1, cost: 0.0042, inputTokens: 3_100 },
          { ...subthreads[2] },
        ],
      })}
      threadId={threadId}
    />
  ),
};

export const UnpricedThread = {
  render: () => (
    <CostBreakdown
      usage={threadUsage({
        threads: [{ ...currentThread, unpricedCalls: currentThread.calls }],
      })}
      threadId={threadId}
    />
  ),
};

export const ManySubThreads = {
  render: () => (
    <OpenOnMount selector={subThreadsTrigger}>
      <CostBreakdown
        usage={threadUsage({
          threads: [
            currentThread,
            ...subthreads,
            ...[
              'Migrate cart totals to cents',
              'Review accessibility of the payment form',
              'Profile checkout bundle size',
              'Draft release notes for checkout v2',
              'Reproduce the duplicated order bug on Safari',
            ].map((name, index) => ({
              ...subthreads[1],
              threadId: `thr_extra_${index}`,
              name,
              calls: 2 + index,
              cost: 0.031 * (index + 1),
            })),
          ],
        })}
        threadId={threadId}
      />
    </OpenOnMount>
  ),
};

export const LongThreadNames = {
  render: () => (
    <OpenOnMount selector={subThreadsTrigger}>
      <CostBreakdown
        usage={threadUsage({
          threads: [
            {
              ...currentThread,
              name: 'Refactor the checkout flow to share the address form with the account settings page',
            },
            {
              ...subthreads[0],
              name: 'Audit every payment integration test that still mocks the legacy Stripe client',
            },
          ],
        })}
        threadId={threadId}
      />
    </OpenOnMount>
  ),
};
