// The window's writes to `files/v1` (1.2.0, §4.4 A9, A10): New file and New
// folder, beside the reads (`reads.ts`). Each answers the method's outcome
// unchanged; the name row that calls them maps every outcome to its text
// ("Non-success answers in the UI"), and a call that throws stays a throw.

import type { Services } from 'bundle/contracts';

import {
  type CreateOutcome,
  type Files,
  FilesV1,
  type LeaseOutcome,
} from '../../contracts/index.js';

export interface FilesWrites {
  /** Creates the empty file `name` in `directory` of the Project. */
  createFile(
    projectId: string,
    directory: string,
    name: string,
  ): Promise<LeaseOutcome<CreateOutcome>>;
  /** Creates the empty directory `name` in `directory` of the Project. */
  createDirectory(
    projectId: string,
    directory: string,
    name: string,
  ): Promise<LeaseOutcome<CreateOutcome>>;
}

/** The writes over `files/v1`, each scoped to its Project. */
export const createFilesWrites = (
  files: (projectId: string) => Files,
): FilesWrites => ({
  createFile: (projectId, directory, name) =>
    files(projectId).createFile({ directory, name }),
  createDirectory: (projectId, directory, name) =>
    files(projectId).createDirectory({ directory, name }),
});

/** The writes bound to a part's services. */
export const filesWritesOf = (services: Services): FilesWrites =>
  createFilesWrites((projectId) => services.use(FilesV1, { projectId }));
