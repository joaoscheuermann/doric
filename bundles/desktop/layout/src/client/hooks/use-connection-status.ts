import { useStore } from 'zustand/react';

import type { ConnectionStatus } from '../domain/connection.js';
import { connectionStore } from '../stores/connection.js';

export const useConnectionStatus = (): ConnectionStatus =>
  useStore(connectionStore(), (state) => state.status);
