export type ConnectionStatus = 'connected' | 'disconnected';

export const connectionLabel = (status: ConnectionStatus): string =>
  status === 'connected' ? 'Connected' : 'Disconnected';
