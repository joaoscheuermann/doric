import { createHash } from 'node:crypto';

import { type CallArg, ContractError, type Storage } from 'bundle/contracts';

import {
  ATTACHMENT_MAX_BYTES,
  type AttachInput,
  type Attachment,
  type AttachmentContent,
  attachmentBlobHash,
  attachmentIdOf,
  attachmentIdSchema,
  attachmentLabel,
  sniffImageMediaType,
} from '../../contracts/attachments.js';
import {
  type AttachmentDocument,
  attachmentDocumentId,
  attachmentDocumentSchema,
  attachmentType,
} from '../../contracts/storage.js';
import { queryAll } from './documents.js';

/*
 * The images a Thread attached (design: image attachments). The bytes are one
 * content-addressed blob, shared by every Thread, of any Project, that attached
 * the same image; a `runtime.attachment/v1` record per Thread is what lets
 * that Thread's Project read it, so a reference line another Project wrote
 * resolves to nothing here.
 *
 * Deleting a Thread or a Project deletes its records in the commit that
 * deletes it (`records`), and `collect` then deletes each blob no record names
 * any more. An attach and a collect of the same blob run one at a time in this
 * process — the one runtime that writes these records — so a collect never
 * deletes the bytes of a record that is being written.
 */

export interface AttachmentKeys {
  /** The record keys, for the deleting commit's `delete`. */
  readonly keys: readonly { readonly type: string; readonly id: string }[];
  /** The attachment ids they name, for `collect` once the commit applied. */
  readonly ids: readonly string[];
}

export interface AttachmentStore {
  attach(
    owner: { readonly projectId: string; readonly threadId: string },
    input: AttachInput,
    call?: CallArg,
  ): Promise<Attachment>;
  read(
    projectId: string,
    id: string,
    call?: CallArg,
  ): Promise<AttachmentContent | undefined>;
  /** The records a Project, or a set of Threads, holds. */
  records(
    of:
      | { readonly projectId: string }
      | { readonly threadIds: readonly string[] },
  ): Promise<AttachmentKeys>;
  /** Deletes the blobs of `ids` that no record names any more. */
  collect(ids: readonly string[]): Promise<void>;
}

const refuse = (message: string): never => {
  throw new ContractError('invalid_input', message);
};

const describe = ({
  id,
  name,
  mediaType,
  size,
}: AttachmentDocument): Attachment => ({ id, name, mediaType, size });

const keysOf = (
  documents: readonly { readonly id: string; readonly value: unknown }[],
): AttachmentKeys => ({
  keys: documents.map(({ id }) => ({ type: attachmentType.type, id })),
  ids: [
    ...new Set(documents.map(({ value }) => (value as AttachmentDocument).id)),
  ],
});

export const createAttachmentStore = (
  storage: Pick<
    Storage,
    'get' | 'query' | 'commit' | 'putBlob' | 'getBlob' | 'deleteBlob'
  >,
  now: () => Date = () => new Date(),
): AttachmentStore => {
  const running = new Map<string, Promise<unknown>>();
  /** Runs `task` after every earlier task on the same blob has settled. */
  const serial = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const result = (running.get(id) ?? Promise.resolve()).then(task, task);
    const settled = result.catch(() => undefined);
    running.set(id, settled);
    void settled.then(() => {
      if (running.get(id) === settled) running.delete(id);
    });
    return result;
  };

  const all = (query: { readonly index: string; readonly equals: string[] }) =>
    queryAll(storage, { type: attachmentType.type, ...query });

  return {
    attach: async ({ projectId, threadId }, { name, bytes }, call) => {
      const decoded = Buffer.from(bytes, 'base64');
      if (decoded.length === 0) refuse('The attachment is empty.');
      if (decoded.length > ATTACHMENT_MAX_BYTES)
        refuse(
          `The attachment is larger than ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB.`,
        );
      const mediaType =
        sniffImageMediaType(decoded) ??
        refuse('The attachment is not a PNG, JPEG, WebP or GIF image.');
      // The blob's own hash, so the write waits on that blob's collect alone.
      const id = attachmentIdOf(
        `sha256:${createHash('sha256').update(decoded).digest('hex')}`,
      );
      return await serial(id, async () => {
        await storage.putBlob(decoded.toString('base64'), call);
        const document: AttachmentDocument = {
          projectId,
          threadId,
          id,
          name: attachmentLabel(name),
          mediaType,
          size: decoded.length,
          createdAt: now().toISOString(),
        };
        await storage.commit(
          {
            put: [
              {
                type: attachmentType.type,
                id: attachmentDocumentId(threadId, id),
                value: document,
              },
            ],
          },
          call,
        );
        return describe(document);
      });
    },
    read: async (projectId, id, call) => {
      if (!attachmentIdSchema.safeParse(id).success) return undefined;
      const page = await storage.query(
        {
          type: attachmentType.type,
          index: 'byProject',
          equals: [projectId, id],
          limit: 1,
        },
        call,
      );
      const parsed = attachmentDocumentSchema.safeParse(page.items[0]?.value);
      if (!parsed.success) return undefined;
      const bytes = await storage.getBlob(attachmentBlobHash(id), call);
      return bytes === undefined
        ? undefined
        : { ...describe(parsed.data), bytes };
    },
    records: async (of) =>
      keysOf(
        'projectId' in of
          ? await all({ index: 'byProject', equals: [of.projectId] })
          : (
              await Promise.all(
                of.threadIds.map((threadId) =>
                  all({ index: 'byThread', equals: [threadId] }),
                ),
              )
            ).flat(),
      ),
    collect: async (ids) => {
      for (const id of ids)
        await serial(id, async () => {
          const named = await storage.query({
            type: attachmentType.type,
            index: 'byBlob',
            equals: [id],
            limit: 1,
          });
          if (named.items.length === 0)
            await storage.deleteBlob(attachmentBlobHash(id));
        });
    },
  };
};

/**
 * Deletes the blobs a deleting commit left unnamed, after it applied. The
 * Thread or Project is already gone by then, so a failure here is not a
 * failure of the delete: the blob stays behind, unreadable, since no record
 * names it.
 */
export const collect = async (
  attachments: Pick<AttachmentStore, 'collect'>,
  ids: readonly string[],
): Promise<void> => {
  try {
    await attachments.collect(ids);
  } catch {
    // Kept: the delete committed; see above.
  }
};
