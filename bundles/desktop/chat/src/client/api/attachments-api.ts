// The images of a Thread's Project, through `runtime.attachments/v1`. The
// reader's paste becomes an attachment before it becomes a line of the prompt,
// and a line the transcript draws reads its image back through the same
// Thread. The renderer's content policy admits `data:` images only, so an
// image is handed to the page as a `data:` URL, kept once per attachment.
// The host is `AttachmentsService`'s generated client (slice S65a), scoped to
// the Thread: `Attach` sends a head and the bytes in chunks, `Read` answers a
// head and the bytes in chunks.

import type { MessageInitShape } from '@bufbuild/protobuf';
import { type Client, ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import { ClientError } from 'desktop/reads';
import {
  ATTACHMENT_MAX_BYTES,
  type Attachment,
  type AttachmentContent,
  attachmentSchema,
  decode,
  type RuntimeAttachments,
} from 'runtime/contracts';
import {
  type Attachment as AttachmentMessage,
  AttachmentSchema,
  AttachmentsService,
  type AttachRequestSchema,
  type AttachResponse,
} from 'runtime/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';

import { chatServices } from '../services/chat-services.js';
import { hostFailure } from './threads-api.js';

export interface ChatAttachmentsApi {
  /** Keeps a file's bytes as an image of the Thread's Project. */
  attach(threadId: string, file: Blob, name: string): Promise<Attachment>;
  /** The image an attachment holds, as a `data:` URL; undefined when the Project holds none by that id. */
  imageUrl(threadId: string, id: string): Promise<string | undefined>;
}

/** The bytes, base64, the way today's shapes carry them. */
const base64Of = (bytes: Uint8Array): string => {
  let binary = '';
  // In slices: one `fromCharCode` over megabytes overflows the call stack.
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
};

/**
 * Why an attach failed, in the reader's terms: a refused image keeps the
 * host's sentence; the code and the cause follow §6.4.
 */
const attachFailure = (error: unknown): ClientError =>
  isContractError(error) && error.code === 'invalid_input'
    ? new ClientError(error.code, error.message, { cause: error })
    : hostFailure(error);

export const createAttachmentsApi = (
  attachments: (threadId: string) => RuntimeAttachments,
): ChatAttachmentsApi => {
  const urls = new Map<string, Promise<string | undefined>>();

  return {
    attach: async (threadId, file, name) => {
      if (file.size > ATTACHMENT_MAX_BYTES)
        throw new ClientError(
          'invalid_input',
          `The image is larger than ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB.`,
        );
      const bytes = base64Of(new Uint8Array(await file.arrayBuffer()));
      try {
        const attached = await attachments(threadId).attach({ name, bytes });
        urls.set(
          attached.id,
          Promise.resolve(`data:${attached.mediaType};base64,${bytes}`),
        );
        return attached;
      } catch (error) {
        throw attachFailure(error);
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

/** The most bytes one `Attach` chunk carries: 1 MiB. */
const CHUNK_BYTES = 1024 * 1024;

/** A Connect failure as its Doric error (`fromConnectError`); any other error unchanged. */
const contractError = (error: unknown): unknown =>
  error instanceof ConnectError ? fromConnectError(error) : error;

/** An attachment message as today's `Attachment`; one outside it is `invalid_output`. */
const attachmentOf = (message: AttachmentMessage): Attachment => {
  const parsed = attachmentSchema.safeParse(decode(AttachmentSchema, message));
  if (!parsed.success)
    throw new ContractError(
      'invalid_output',
      `runtime.attachments/v1 answered outside its schema: ${parsed.error.message}`,
    );
  return parsed.data;
};

/** `bytes` in chunks of at most `CHUNK_BYTES`. */
function* chunksOf(bytes: Uint8Array): Generator<Uint8Array> {
  for (let start = 0; start < bytes.length; start += CHUNK_BYTES)
    yield bytes.subarray(start, start + CHUNK_BYTES);
}

/** The `Attach` items of an image: the head, then its bytes in chunks. */
async function* attachItems(
  name: string,
  bytes: Uint8Array,
): AsyncGenerator<MessageInitShape<typeof AttachRequestSchema>> {
  yield { item: { case: 'head', value: { name } } };
  for await (const chunk of chunksOf(bytes))
    yield { item: { case: 'chunk', value: chunk } };
}

/**
 * `runtime.attachments/v1` as today's shapes over `AttachmentsService`'s
 * client: `attach` sends the decoded bytes in chunks, `read` joins the
 * chunks it answers; each failure is its Doric error.
 */
const attachmentsOver = (
  client: Pick<Client<typeof AttachmentsService>, 'attach' | 'read'>,
): RuntimeAttachments => ({
  attach: async ({ name, bytes }) => {
    let response: AttachResponse;
    try {
      response = await client.attach(
        attachItems(
          name,
          Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0)),
        ),
      );
    } catch (error) {
      throw contractError(error);
    }
    if (response.attachment === undefined)
      throw new ContractError(
        'invalid_output',
        'runtime.attachments/v1 answered no attachment.',
      );
    return attachmentOf(response.attachment);
  },
  read: async ({ id }) => {
    let attachment: Attachment | undefined;
    const chunks: Uint8Array[] = [];
    try {
      for await (const { item } of client.read({ id })) {
        if (item.case === 'head') {
          if (item.value.attachment === undefined) return undefined;
          attachment = attachmentOf(item.value.attachment);
        } else if (item.case === 'chunk') {
          chunks.push(item.value);
        }
      }
    } catch (error) {
      throw contractError(error);
    }
    if (attachment === undefined) return undefined;
    const joined = new Uint8Array(
      chunks.reduce((total, chunk) => total + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    const content: AttachmentContent = {
      ...attachment,
      bytes: base64Of(joined),
    };
    return content;
  },
});

export const attachmentsApi = createAttachmentsApi((threadId) =>
  attachmentsOver(chatServices().use(AttachmentsService, { threadId })),
);
