// The resources client's element (§3.12), built inside a factory the
// activation calls, so importing this module touches no DOM global [D10-7].
// It renders in light DOM with `display: contents`, with the bundle's own
// query client.

import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import type { ReactNode } from 'react';

import { ResourcesMonitorView } from './monitor/resources-monitor.js';

/**
 * Builds the `<resources-monitor>` element class around `client`. Every
 * element renders under that `QueryClient`, so a caller that owns the client
 * (a test) can `refetchQueries` it and `clear()` it. It touches no DOM global
 * until an element connects.
 */
export const defineResourcesElements = (client: QueryClient) => ({
  monitor: defineReactElement<object>({
    props: [],
    wrap: () =>
      function ResourcesRoot({ children }: { readonly children?: ReactNode }) {
        return (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
      },
    render: ({ services }: { readonly services: Services }) => (
      <ResourcesMonitorView services={services} />
    ),
  }),
});
