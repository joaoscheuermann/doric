// D8: papercraft keeps its runner and jobs out of Git and leaves `schemas/`
// versioned. Before any runner job writes under `.doric/papercraft/` of the
// workspace root, the host writes `.doric/papercraft/.gitignore` when it is
// absent, and once per host session per Project it runs the migration of the
// old Doric-wide `.doric/.gitignore`.

import type { RunnerSandbox } from './sandbox.js';

/** The content of `.doric/papercraft/.gitignore` (D8), with its final newline. */
export const PAPERCRAFT_GITIGNORE =
  '# Written by papercraft: the runner and its jobs stay out of Git; schemas/ is versioned.\n' +
  '/*\n' +
  '!/.gitignore\n' +
  '!/schemas/\n';

/** papercraft's folder under the workspace root (D8). */
const PAPERCRAFT_DIR = '.doric/papercraft';

/** The content `artifacts` writes into its own folder (D8). */
const ARTIFACTS_GITIGNORE = '*\n';

/** The old Doric-wide ignore file's content the migration removes: exactly `*`. */
const OLD_CONTENT = /^\*\r?\n?$/u;

/** The Projects whose migration ran in this host session. */
const migrated = new Set<string>();

/**
 * Makes the D8 layout hold under `root` in `sandbox` before a runner job:
 * writes `.doric/papercraft/.gitignore` with `PAPERCRAFT_GITIGNORE` when the
 * file is absent (an existing file is never rewritten), and, the first time
 * for `projectId` in this host session, deletes `.doric/.gitignore` only when
 * its content is exactly `*`, after writing `.doric/artifacts/.gitignore` when
 * `.doric/artifacts/` exists. Any other content is left as it is. Never
 * rejects: a failed step is left for the next call, and the session flag is
 * set only once the migration succeeded.
 */
export const ensureIgnoreFiles = async (
  sandbox: RunnerSandbox,
  root: string,
  projectId: string,
): Promise<void> => {
  const base = root.replace(/\/+$/u, '');
  const isFile = async (path: string): Promise<boolean> =>
    (await sandbox.exec({ cmd: ['test', '-f', path] })).exitCode === 0;

  // 1. papercraft's own ignore file, before anything is written beside it.
  try {
    const own = `${base}/${PAPERCRAFT_DIR}/.gitignore`;
    if (!(await isFile(own))) {
      await sandbox.putFile(own, Buffer.from(PAPERCRAFT_GITIGNORE, 'utf8'));
    }
  } catch {
    // Left for the next job.
  }

  // 2. The migration of the old Doric-wide ignore file, once per session.
  if (migrated.has(projectId)) return;

  try {
    const old = `${base}/.doric/.gitignore`;

    if (
      (await isFile(old)) &&
      OLD_CONTENT.test(Buffer.from(await sandbox.getFile(old)).toString('utf8'))
    ) {
      const artifacts = `${base}/.doric/artifacts`;
      const hasArtifacts =
        (await sandbox.exec({ cmd: ['test', '-d', artifacts] })).exitCode === 0;

      if (hasArtifacts && !(await isFile(`${artifacts}/.gitignore`))) {
        await sandbox.putFile(
          `${artifacts}/.gitignore`,
          Buffer.from(ARTIFACTS_GITIGNORE, 'utf8'),
        );
      }

      const removed = await sandbox.exec({ cmd: ['rm', '-f', '--', old] });
      if (removed.exitCode !== 0) return;
    }

    migrated.add(projectId);
  } catch {
    // Left for the next job: the flag stays unset.
  }
};
