import { UsageSummary } from '../../src/client/components/usage-summary.js';
import { usageQueryKey } from '../../src/client/domain/read.js';
import { footerDecorator } from '../support/footer.js';
import { WithQueryClient } from '../support/query.js';
import { summaryServices, threadId, threadUsage } from '../support/usage.js';

export default {
  title: 'Usage/Components/Usage summary',
  component: UsageSummary,
  decorators: [footerDecorator],
};

export const SelectedThread = {
  render: () => (
    <WithQueryClient
      seed={(client) =>
        client.setQueryData(usageQueryKey(threadId), threadUsage())
      }
    >
      <UsageSummary services={summaryServices()} />
    </WithQueryClient>
  ),
};

export const FirstRead = {
  render: () => (
    <WithQueryClient>
      <UsageSummary services={summaryServices()} />
    </WithQueryClient>
  ),
};

export const WithoutUsageProvider = {
  render: () => (
    <WithQueryClient>
      <UsageSummary services={summaryServices({ usage: null })} />
    </WithQueryClient>
  ),
};

export const NoSelectedThread = {
  render: () => (
    <WithQueryClient>
      <UsageSummary services={summaryServices({ selected: null })} />
    </WithQueryClient>
  ),
};
