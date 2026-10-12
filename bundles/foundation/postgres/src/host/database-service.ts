import { defineMethod, defineService } from 'bundle/contracts';

import {
  PostgresDatabaseV1,
  postgresDatabaseMethods,
} from '../contracts/index.js';
import type { DatabaseHandle } from './database.js';

/** `postgres.database/v1` (provisional): the kernel's way to the client. */
export const databaseService = (handle: DatabaseHandle) =>
  defineService(PostgresDatabaseV1, {
    connect: defineMethod({
      ...postgresDatabaseMethods.connect,
      execute: () => handle.connect(),
    }),
    client: defineMethod({
      ...postgresDatabaseMethods.client,
      execute: () => handle.client(),
    }),
  });
