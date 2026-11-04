import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api } from '../api/settings-api.js';
import {
  type IconLookup,
  type IconRequest,
  iconLookupFrom,
  noIcons,
} from '../domain/model-icons.js';
import { queryKeys } from '../queries/keys.js';

/**
 * The icons the host answers for these requests, or `undefined` until the
 * first answer arrives. No requests answers `noIcons` without asking. A change
 * of the requests asks again at once, and the previous icons stay until the
 * new answer replaces them, each read against the requests it answered. A
 * failure answers `noIcons`: an icon is never an error the reader has to act
 * on.
 */
export const useModelIcons = (
  requests: readonly IconRequest[],
): IconLookup | undefined => {
  const asked = requests.length > 0;
  const icons = useQuery({
    queryKey: queryKeys.modelIcons(requests),
    queryFn: async () =>
      iconLookupFrom(requests, await api().providers.icons(requests)),
    enabled: asked,
    placeholderData: keepPreviousData,
  });

  if (!asked || icons.isError) return noIcons;
  return icons.data;
};
