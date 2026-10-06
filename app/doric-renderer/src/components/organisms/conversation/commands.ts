import type { QueueItem } from '@/domain/queue';
import { createCommand } from 'lexical';

export const EDIT_QUEUE_PROMPT_COMMAND =
  createCommand<QueueItem>('EDIT_QUEUE_PROMPT');
export const SAVE_QUEUE_EDIT_COMMAND = createCommand<void>('SAVE_QUEUE_EDIT');
