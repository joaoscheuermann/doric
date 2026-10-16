import { createCommand } from 'lexical';

import type { QueueItem } from '../../../domain/queue.js';

export const EDIT_QUEUE_PROMPT_COMMAND =
  createCommand<QueueItem>('EDIT_QUEUE_PROMPT');
export const SAVE_QUEUE_EDIT_COMMAND = createCommand<void>('SAVE_QUEUE_EDIT');

/**
 * Sends the prompt with the composer's stack, as Cmd/Ctrl+Enter does: what a
 * control outside the editor's own keys — a stack note — dispatches to send.
 */
export const SEND_PROMPT_COMMAND = createCommand<void>('SEND_PROMPT');
