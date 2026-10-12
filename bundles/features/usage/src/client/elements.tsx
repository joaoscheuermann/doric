// `<usage-summary>` (stage 10, §3.11), built inside a factory the activation
// calls, so importing this module touches no DOM global [D10-7]. Light DOM
// with `display: contents`; its root has its own tooltip provider and the
// bundle's one query client.

import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop-ui/react-element';
import { TooltipProvider } from 'desktop-ui/tooltip';
import type { ReactNode } from 'react';

import { UsageSummary } from './components/usage-summary.js';

export const defineUsageElements = (client: QueryClient) => ({
  summary: defineReactElement<object>({
    props: [],
    wrap: () =>
      function UsageRoot({ children }: { readonly children?: ReactNode }) {
        return (
          <QueryClientProvider client={client}>
            <TooltipProvider>{children}</TooltipProvider>
          </QueryClientProvider>
        );
      },
    render: ({ services }: { readonly services: Services }) => (
      <UsageSummary services={services} />
    ),
  }),
});
