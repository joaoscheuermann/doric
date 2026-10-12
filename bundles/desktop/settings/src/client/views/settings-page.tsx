import { QueryClientProvider } from '@tanstack/react-query';
import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop-ui/react-element';
import { Toaster } from 'desktop-ui/sonner';
import { TooltipProvider } from 'desktop-ui/tooltip';
import { type ReactNode, StrictMode, useEffect } from 'react';

import { ExecutionPicker } from '../components/organisms/execution-picker.js';
import { settingsQueryClient } from '../queries/client.js';
import { Settings } from './settings-view.js';

/** The settings window's page: the title it names itself by, then the view. */
function SettingsPage({ services }: { readonly services: Services }) {
  // The shell is one page for every window, so the settings window names
  // itself; its former page carried this title.
  useEffect(() => {
    document.title = 'Doric Settings';
  }, []);

  return <Settings services={services} />;
}

/**
 * `<settings-page>`, at `/settings`: the settings window's one React root. The
 * window is its own document, so the page mounts its own toaster: the one in
 * the main window belongs to a different document and could never render here.
 */
export const SettingsPageElement = defineReactElement({
  props: [],
  render: SettingsPage,
  wrap: () =>
    function SettingsPageRoot({ children }: { readonly children?: ReactNode }) {
      return (
        <StrictMode>
          <QueryClientProvider client={settingsQueryClient()}>
            {children}
            <Toaster />
          </QueryClientProvider>
        </StrictMode>
      );
    },
});

/**
 * `<settings-execution-picker>`, a `layout.footer` item (D9-13): the execution
 * model and effort of the conversation footer, in its own root. It autosaves
 * with no flush on close and no toast, as it always has.
 */
export const ExecutionPickerElement = defineReactElement({
  props: [],
  render: () => <ExecutionPicker />,
  wrap: () =>
    function ExecutionPickerRoot({
      children,
    }: {
      readonly children?: ReactNode;
    }) {
      return (
        <StrictMode>
          <QueryClientProvider client={settingsQueryClient()}>
            <TooltipProvider>{children}</TooltipProvider>
          </QueryClientProvider>
        </StrictMode>
      );
    },
});
