import type { SerializedElementNode } from 'lexical';
import { createStore } from 'zustand/vanilla';

import type { QueueItem } from '@/domain/queue';

export interface QueueEdit {
  readonly item: QueueItem;
  readonly revision: number;
  readonly original: string;
  readonly text: string;
  readonly draft: SerializedElementNode;
  readonly saving: boolean;
  /** A successful offscreen save restores the captured draft on remount. */
  readonly restore?: boolean;
  readonly error?: string;
}

/** Per-Thread editing state; the normal composer draft is restored when editing ends. */
export const queueEditStore = createStore<{
  readonly edits: Readonly<Record<string, QueueEdit | undefined>>;
  set(id: string, edit: QueueEdit | undefined): void;
  patch(id: string, patch: Partial<QueueEdit>): void;
}>((set) => ({
  edits: {},
  set: (id, edit) =>
    set((state) => ({ edits: { ...state.edits, [id]: edit } })),
  patch: (id, patch) =>
    set((state) => {
      const edit = state.edits[id];
      return edit === undefined
        ? state
        : { edits: { ...state.edits, [id]: { ...edit, ...patch } } };
    }),
}));
