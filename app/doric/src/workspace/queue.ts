export interface QueueItem {
  readonly promptId: string;
  readonly source: {
    readonly kind: 'user' | 'terminal' | 'parent' | 'result';
    readonly threadId?: string;
    readonly terminalId?: string;
  };
  readonly label: string;
  readonly preview: string;
  readonly acceptedAt: string;
  readonly editable?: boolean;
  readonly revision?: number;
}
export interface QueuedPrompt {
  readonly promptId: string;
  readonly text: string;
  readonly revision: number;
  readonly editable: boolean;
}
export interface ThreadQueue {
  readonly error?: { readonly code: string; readonly message: string };
  readonly revision: number;
  readonly paused: boolean;
  readonly stopping: boolean;
  readonly current?: QueueItem;
  readonly resumable?: QueueItem;
  readonly items: readonly QueueItem[];
}
