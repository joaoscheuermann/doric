import type { ConnectionStatus } from '@/domain/connection';
import { useSyncExternalStore } from 'react';

const getSnapshot = (): ConnectionStatus => window.doric.connection.status();
const subscribe = (listener: () => void): (() => void) =>
  window.doric.connection.subscribe(listener);

export const useConnectionStatus = (): ConnectionStatus =>
  useSyncExternalStore(subscribe, getSnapshot);
