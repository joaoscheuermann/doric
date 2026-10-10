import type { DockerClient, DockerRequestOptions } from './types/docker.js';

const pattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

/** The named volume that holds one durable workspace. */
export const workspaceVolume = (identity: string): string => {
  if (!pattern.test(identity)) {
    throw new Error(
      `Sandbox workspace identity must match ${pattern}: ${identity}`,
    );
  }

  return `doric-workspace-${identity}`;
};

/**
 * Creates the volume for one durable workspace, keeping the files an existing
 * volume already holds.
 */
export const ensureWorkspaceVolume = async (
  client: DockerClient,
  identity: string,
  options: DockerRequestOptions,
): Promise<string> => {
  const name = workspaceVolume(identity);

  await client.createVolume(
    { name, labels: { 'doric.sandbox.workspace': identity } },
    options,
  );

  return name;
};

/**
 * Removes the volume that holds one durable workspace. Removing a volume that
 * is already gone succeeds, so a repeated deletion is safe.
 */
export const discardWorkspace = async (
  client: DockerClient,
  identity: string,
): Promise<void> => {
  await client.removeVolume(workspaceVolume(identity), { force: true });
};
