// The images of a Thread's Project, through `runtime.attachments/v1`. The
// reader's paste becomes an attachment before it becomes a line of the prompt,
// and a line the transcript draws reads its image back through the same
// Thread. The renderer's content policy admits `data:` images only, so an
// image is handed to the page as a `data:` URL, kept once per attachment.

import { isContractError } from 'bundle/contracts';
import {
  ATTACHMENT_MAX_BYTES,
  type Attachment,
  type RuntimeAttachments,
  RuntimeAttachmentsV1,
} from 'runtime/contracts';

import { chatServices } from '../services/chat-services.js';
import { hostFailureMessage } from './threads-api.js';

export interface ChatAttachmentsApi {
  /** Keeps a file's bytes as an image of the Thread's Project. */
  attach(threadId: string, file: Blob, name: string): Promise<Attachment>;
  /** The image an attachment holds, as a `data:` URL; undefined when the Project holds none by that id. */
  imageUrl(threadId: string, id: string): Promise<string | undefined>;
}

/** The file's bytes, base64, the way the contract carries them. */
const base64Of = async (file: Blob): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // In slices: one `fromCharCode` over megabytes overflows the call stack.
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
};

/** Why an attach failed, in the reader's terms. */
const attachFailure = (error: unknown): string =>
  isContractError(error) && error.code === 'invalid_input'
    ? error.message
    : hostFailureMessage(error);

export const createAttachmentsApi = (
  attachments: (threadId: string) => RuntimeAttachments,
): ChatAttachmentsApi => {
  const urls = new Map<string, Promise<string | undefined>>();

  return {
    attach: async (threadId, file, name) => {
      if (file.size > ATTACHMENT_MAX_BYTES)
        throw new Error(
          `The image is larger than ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB.`,
        );
      const bytes = await base64Of(file);
      try {
        const attached = await attachments(threadId).attach({ name, bytes });
        urls.set(
          attached.id,
          Promise.resolve(`data:${attached.mediaType};base64,${bytes}`),
        );
        return attached;
      } catch (error) {
        throw new Error(attachFailure(error));
      }
    },
    imageUrl: (threadId, id) => {
      let url = urls.get(id);
      if (url === undefined) {
        url = attachments(threadId)
          .read({ id })
          .then((content) =>
            content === undefined
              ? undefined
              : `data:${content.mediaType};base64,${content.bytes}`,
          );
        // A failed read is not kept, so the next draw asks again.
        url.catch(() => urls.delete(id));
        urls.set(id, url);
      }
      return url;
    },
  };
};

export const attachmentsApi = createAttachmentsApi((threadId) =>
  chatServices().use(RuntimeAttachmentsV1, { threadId }),
);
