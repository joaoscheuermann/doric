import type { Services } from 'bundle/contracts';
import { useEffect, useState } from 'react';

import {
  type DecorationsObservation,
  FilesDecorationsV1,
} from '../../contracts/index.js';
import {
  type MergedDecorations,
  mergeDecorations,
} from '../tree/decorations.js';

/**
 * The merged marks of every provider of `files.decorations/v1` for one
 * Project and working directory (the Thread's raw cwd), while this view shows
 * them; undefined with no Project or no provider.
 */
export const useDecorations = (
  services: Services,
  projectId: string | undefined,
  cwd: string | undefined,
): MergedDecorations | undefined => {
  const [merged, setMerged] = useState<MergedDecorations | undefined>();
  useEffect(() => {
    if (projectId === undefined) {
      setMerged(undefined);
      return;
    }
    const answers = new Map<string, DecorationsObservation>();
    let current: MergedDecorations | undefined;
    let active = true;
    const publish = () => {
      if (!active) return;
      current =
        answers.size === 0
          ? undefined
          : mergeDecorations(
              [...answers].map(([bundleId, observation]) => ({
                bundleId,
                observation,
              })),
              current,
            );
      setMerged(current);
    };
    const binding = services.whenAvailable(
      FilesDecorationsV1,
      (api, { bundleId }) => {
        const observation = api.observe(
          { projectId, ...(cwd === undefined ? {} : { cwd }) },
          (state) => {
            answers.set(bundleId, state);
            publish();
          },
        );
        return () => {
          observation.dispose();
          answers.delete(bundleId);
          publish();
        };
      },
    );
    return () => {
      active = false;
      binding.dispose();
      setMerged(undefined);
    };
  }, [services, projectId, cwd]);
  return merged;
};
