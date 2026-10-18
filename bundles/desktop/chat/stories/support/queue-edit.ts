// Seeds the queued-prompt edit a Thread holds open (`stores/queue-edit`), so
// the footer shows its Save state the way it does while the reader edits a
// queued prompt in the conversation.

import type { SerializedElementNode, SerializedTextNode } from 'lexical';

import type { QueueItem } from '../../src/client/domain/queue.js';
import { queueEditStore } from '../../src/client/stores/queue-edit.js';

const paragraph = (text: string): SerializedElementNode => {
  const words: SerializedTextNode = {
    type: 'text',
    version: 1,
    text,
    detail: 0,
    format: 0,
    mode: 'normal',
    style: '',
  };
  return {
    type: 'paragraph',
    version: 1,
    direction: null,
    format: '',
    indent: 0,
    children: [words],
  };
};

/** Opens an edit of `item` on `threadId` holding `text`; once per Thread. */
export const seedQueueEdit = (
  threadId: string,
  item: QueueItem,
  text: string,
): void => {
  if (queueEditStore.getState().edits[threadId] !== undefined) return;
  queueEditStore.getState().set(threadId, {
    item,
    revision: item.revision ?? 1,
    stored: item.preview,
    original: item.preview,
    text,
    draft: paragraph(text),
    saving: false,
  });
};
