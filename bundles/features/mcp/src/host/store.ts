// Where the bundle keeps its servers: one storage/v1 document per server,
// listed per Project in creation order. No secret is ever stored here: a
// token or a client secret is an MCP_TOKEN credential of secrets/v1, and the
// document holds its id.

import { defineStorageType, type Storage } from 'bundle/contracts';
import { createdKey } from 'runtime/contracts';
import { z } from 'zod';

import { mcpServerInputSchema } from '../contracts/index.js';

/** The client an OAuth registration answered, without its secret. */
const storedClientInformationSchema = z.looseObject({
  client_id: z.string().min(1),
  client_secret: z.never().optional(),
});

/** What discovery found: the authorization server and its metadata. */
const storedDiscoveryStateSchema = z.looseObject({
  authorizationServerUrl: z.string(),
});

/** The non-secret part of a server's OAuth state, with its credentials' ids. */
const storedOAuthSchema = z
  .object({
    clientInformation: storedClientInformationSchema.optional(),
    discoveryState: storedDiscoveryStateSchema.optional(),
    tokenType: z.string().optional(),
    scope: z.string().optional(),
    accessCredentialId: z.string().optional(),
    refreshCredentialId: z.string().optional(),
    clientSecretCredentialId: z.string().optional(),
  })
  .strict();

export type StoredOAuth = z.output<typeof storedOAuthSchema>;

const serverDocumentSchema = mcpServerInputSchema
  .extend({
    id: z.uuid(),
    projectId: z.uuid(),
    createdKey: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    oauth: storedOAuthSchema.optional(),
  })
  .strict();

export type ServerDocument = z.output<typeof serverDocumentSchema>;

/** `mcp.server/v1`: one document per server, listed per Project in creation order. */
export const serverType = defineStorageType({
  type: 'mcp.server/v1',
  schema: serverDocumentSchema,
  indexes: [{ name: 'byProject', fields: ['projectId', 'createdKey'] }],
});

/** A new server's document: its timestamps and its place in the Project's list. */
export const newDocument = (
  fields: Omit<
    ServerDocument,
    'createdKey' | 'createdAt' | 'updatedAt' | 'oauth'
  >,
): ServerDocument => {
  const now = new Date().toISOString();

  return {
    ...fields,
    createdKey: createdKey(now, fields.id),
    createdAt: now,
    updatedAt: now,
  };
};

/** The servers' documents. */
export interface ServerStore {
  /** The Project's servers in creation order. */
  list(projectId: string): Promise<readonly ServerDocument[]>;
  get(id: string): Promise<ServerDocument | undefined>;
  put(document: ServerDocument): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * Runs `task` once every earlier task of the same server ended, so a
   * read-change-write of one document never loses another's change. A task
   * must not lock the same server again.
   */
  lock<T>(id: string, task: () => Promise<T>): Promise<T>;
}

const PAGE = 1000;

export const createServerStore = (
  storage: Pick<Storage, 'get' | 'query' | 'commit'>,
): ServerStore => {
  const queues = new Map<string, Promise<void>>();

  const list = async (projectId: string): Promise<ServerDocument[]> => {
    const documents: ServerDocument[] = [];
    let cursor: string | undefined;

    do {
      const page = await storage.query({
        type: serverType.type,
        index: 'byProject',
        equals: [projectId],
        order: 'asc',
        limit: PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      documents.push(
        ...page.items.map((item) => serverDocumentSchema.parse(item.value)),
      );
      cursor = page.cursor;
    } while (cursor !== undefined);

    return documents;
  };

  return {
    list,
    get: async (id) => {
      const stored = await storage.get({ type: serverType.type, id });

      return stored === undefined
        ? undefined
        : serverDocumentSchema.parse(stored.value);
    },
    put: async (document) => {
      await storage.commit({
        put: [{ type: serverType.type, id: document.id, value: document }],
      });
    },
    remove: async (id) => {
      await storage.commit({ delete: [{ type: serverType.type, id }] });
    },
    lock: (id, task) => {
      // The queue holds settled promises only, so a failed task never stops
      // the next one.
      const run = (queues.get(id) ?? Promise.resolve()).then(task);
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      queues.set(id, settled);
      void settled.then(() => {
        if (queues.get(id) === settled) queues.delete(id);
      });

      return run;
    },
  };
};
