import type { ConnectionStatus } from '@/domain/connection';
import { connectionStore } from '@/stores/connection';
import { useStore } from 'zustand/react';

export const useConnectionStatus = (): ConnectionStatus =>
  useStore(connectionStore(), (state) => state.status);
