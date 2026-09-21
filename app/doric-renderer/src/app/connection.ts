export type ConnectionStatus = 'connected' | 'disconnected';

export type ConnectionApi = {
  status(): ConnectionStatus;
  subscribe(listener: () => void): () => void;
};

export const connectionLabel = (status: ConnectionStatus): string =>
  status === 'connected' ? 'Connected' : 'Disconnected';
