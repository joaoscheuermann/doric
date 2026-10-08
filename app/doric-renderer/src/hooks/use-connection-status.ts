import { useStore } from 'zustand/react';

import type { ConnectionStatus } from '@/domain/connection';
import { connectionStore } from '@/stores/connection';

export const useConnectionStatus = (): ConnectionStatus =>
  useStore(connectionStore(), (state) => state.status);
