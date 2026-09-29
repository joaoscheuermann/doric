import { Toaster } from '@/components/ui/sonner';
import Settings from '@/views/settings';
import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);
root.render(
  <StrictMode>
    {/**
     * The settings window is its own document with its own root, so it mounts its
     * own toaster: the one in the main window belongs to a different document and
     * could never render here.
     */}
    <Settings />
    <Toaster />
  </StrictMode>,
);
