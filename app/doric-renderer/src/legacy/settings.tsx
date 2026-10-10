import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'desktop-ui/sonner';
import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';

import { createQueryClient } from '@/queries/client';
import Settings from '@/views/settings';

/** The settings window's tree, as the former `settings.tsx` mounted it. */
export const mountSettings = (container: HTMLElement): void => {
  // The shell is one page for every window, so the settings window names
  // itself; its former page carried this title.
  document.title = 'Doric Settings';
  const queryClient = createQueryClient();
  const root = ReactDOM.createRoot(container);
  root.render(
    <StrictMode>
      {/**
       * The settings window is its own document with its own root, so it mounts its
       * own toaster: the one in the main window belongs to a different document and
       * could never render here.
       */}
      <QueryClientProvider client={queryClient}>
        <Settings />
        <Toaster />
      </QueryClientProvider>
    </StrictMode>,
  );
};
