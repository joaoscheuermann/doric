import { QueryClientProvider } from '@tanstack/react-query';
import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import { SidebarScope } from 'desktop/ui/sidebar';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { type ReactNode, StrictMode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { api } from '../api/settings-api.js';
import { DashboardProviderPage } from '../components/organisms/dashboard-provider-page.js';
import { DashboardProvidersGroup } from '../components/organisms/dashboard-providers.js';
import { PROVIDER_PAGE_ID, providerPageHosts } from '../elements.js';
import {
  useClaudeLogin,
  useClaudeLoginAvailable,
} from '../hooks/use-claude-login.js';
import { useConfig } from '../hooks/use-config.js';
import { useConfigAutosave } from '../hooks/use-config-autosave.js';
import { useCredentials } from '../hooks/use-credentials.js';
import { useDashboardPage } from '../hooks/use-dashboard-page.js';
import { useProviderKinds } from '../hooks/use-provider-kinds.js';
import { useProviderPage } from '../hooks/use-provider-page.js';
import { settingsQueryClient } from '../queries/client.js';

/**
 * The dashboard's Providers: the group of rows in the dashboard sidebar and
 * the open provider's page, which this root renders into the
 * `<settings-dashboard-provider>` host the dashboard mounts while the page is
 * the one it shows. Both read one draft, which autosaves like the settings
 * window's and flushes as the window closes or this root goes away.
 */
function DashboardProviders({ services }: { readonly services: Services }) {
  const credentials = useCredentials();
  const claudeLogin = useClaudeLogin();
  const claudeLoginAvailable = useClaudeLoginAvailable();
  const kinds = useProviderKinds();
  const config = useConfig(true, kinds.list);
  useConfigAutosave(services, config);
  const page = useProviderPage({
    config,
    kinds: kinds.list,
    credentials: credentials.list,
    claudeLogin,
  });
  const shown = useDashboardPage() === PROVIDER_PAGE_ID;
  const host = providerPageHosts.useHosts().at(-1)?.element;
  const { flush } = config;
  const { close } = page;

  // The dashboard showing another page, or its list, leaves no provider open.
  useEffect(() => {
    if (!shown) close();
  }, [shown, close]);

  // The group leaving the dashboard sends the change waiting on the debounce,
  // read through a ref so a new `flush` (after each save) does not send early.
  const latestFlush = useRef(flush);
  latestFlush.current = flush;
  useEffect(() => () => void latestFlush.current(), []);

  const open = (index: number): void => {
    page.open(index);
    api().dashboard.show(PROVIDER_PAGE_ID);
  };
  const openNew = (): void => {
    page.openNew();
    api().dashboard.show(PROVIDER_PAGE_ID);
  };

  return (
    <>
      <DashboardProvidersGroup
        draft={config.draft}
        kinds={kinds.list}
        activeIndex={shown ? page.provider?.index : undefined}
        onOpen={open}
        onAdd={openNew}
      />
      {shown &&
        page.provider !== undefined &&
        host !== undefined &&
        createPortal(
          <DashboardProviderPage
            {...(claudeLoginAvailable ? { claudeLogin } : {})}
            credentials={credentials.list}
            draft={page.provider}
            kinds={kinds.list}
            onChange={page.change}
            onFlush={() => void flush()}
          />,
          host,
        )}
    </>
  );
}

/**
 * `<settings-dashboard-providers>`, a `layout.dashboard.nav` item: the
 * Providers group of the /projects dashboard sidebar, in its own root.
 */
export const DashboardProvidersElement = defineReactElement({
  props: [],
  render: DashboardProviders,
  wrap: () =>
    function DashboardProvidersRoot({
      children,
    }: {
      readonly children?: ReactNode;
    }) {
      return (
        <StrictMode>
          <QueryClientProvider client={settingsQueryClient()}>
            <TooltipProvider>
              <SidebarScope>{children}</SidebarScope>
            </TooltipProvider>
          </QueryClientProvider>
        </StrictMode>
      );
    },
});
