import type { ConnectionStatus } from 'bundle/contracts';
import { useStore } from 'zustand/react';

import { connectionStore } from '../stores/connection.js';

export const useConnectionStatus = (): ConnectionStatus =>
  useStore(connectionStore(), (state) => state.status);
