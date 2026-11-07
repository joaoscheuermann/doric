// The old artifacts cache (papercraft-openui.md D25, PC22): stage 4 removed
// the artifacts bundle, and nothing serves or writes `userData/artifacts/` any
// more. Each start deletes it before any window opens; a symlink there is
// removed, never followed.

import { rm } from 'node:fs/promises';

import type { DesktopPaths } from './paths';

/** D25/PC22: deletes the old artifacts cache when it exists (fs.rm recursive+force). */
export const removeArtifactsCache = async (
  paths: Pick<DesktopPaths, 'artifacts'>,
): Promise<void> => {
  await rm(paths.artifacts, { recursive: true, force: true });
};
