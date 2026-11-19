import { QueryClientProvider } from '@tanstack/react-query';
import { RegionsV1, type Services, UiV1 } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import { SidebarScope } from 'desktop/ui/sidebar';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { type ReactNode, StrictMode, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

import { api, settingsServices } from '../api/settings-api.js';
import { DashboardProviderPage } from '../components/organisms/dashboard-provider-page.js';
import { DashboardProvidersGroup } from '../components/organisms/dashboard-providers.js';
import { PROVIDER_PAGE_ID, providerPageHosts } from '../elements.js';
import { useConfig } from '../hooks/use-config.js';
import { useConfigAutosave } from '../hooks/use-config-autosave.js';
import { useCredentials } from '../hooks/use-credentials.js';
import { useDashboardPage } from '../hooks/use-dashboard-page.js';
import { useProviderFieldEntries } from '../hooks/use-provider-fields.js';
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
  const kinds = useProviderKinds();
  const config = useConfig(true, kinds.list);
  useConfigAutosave(services, config);
  const page = useProviderPage({
    config,
    kinds: kinds.list,
    credentials: credentials.list,
  });
  // Another bundle's field item is created through the activation services
  // (D9-17), not this element's.
  const ui = useMemo(() => settingsServices().use(UiV1), []);
  const regions = useMemo(() => settingsServices().use(RegionsV1), []);
  const fieldEntries = useProviderFieldEntries(regions);
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
        failure={
          kinds.error !== undefined
            ? {
                error: kinds.error,
                fallbackCode: 'kinds_read_failed',
                retry: kinds.reload,
                retrying: kinds.loading,
              }
            : credentials.loadError !== undefined
              ? {
                  error: credentials.loadError,
                  fallbackCode: 'credentials_read_failed',
                  retry: credentials.reload,
                  retrying: credentials.loading,
                }
              : undefined
        }
      />
      {shown &&
        page.provider !== undefined &&
        host !== undefined &&
        createPortal(
          <DashboardProviderPage
            credentials={credentials.list}
            draft={page.provider}
            fieldItems={{
              ui,
              entries: fieldEntries,
              onAnswer: page.answerField,
            }}
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
 * `<settings-dashboard-providers>`, a `workspace.dashboard.nav` item: the
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
