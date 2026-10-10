import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';

import { createQueryClient } from '@/queries/client';
import App from '@/views/app';

/** The workspace window's tree, as the former `main.tsx` mounted it. */
export const mountWorkspace = (container: HTMLElement): void => {
  const queryClient = createQueryClient();
  const root = ReactDOM.createRoot(container);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
};
