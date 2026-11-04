// The icon of the model that answered a turn, read from the host's
// `models/v1.icons`. Only a refusal that proves the host has no icons is a
// known absence (`null`); every other failure rejects, so the mark stays empty
// rather than drawing the bot glyph for an icon that may exist.

import { isContractError, type Models } from 'bundle/contracts';

import { chatQueryClient } from '../queries/client.js';

let modelsApi: Pick<Models, 'icons'> | undefined;

/**
 * Stores the `models/v1` handle while the host provides it, and `undefined`
 * once it leaves. Each call invalidates every cached icon (`['models',
 * 'icon']`) on `chatQueryClient`, so marks drawn before it are read again.
 */
export const setModelsApi = (api: Pick<Models, 'icons'> | undefined): void => {
  modelsApi = api;
  void chatQueryClient.invalidateQueries({ queryKey: ['models', 'icon'] });
};

/**
 * Whether an error is the window's own stub refusing a `models/v1` that has no
 * `icons`: code `unavailable`, details exactly `{ contract: 'models/v1',
 * method: 'icons' }`.
 */
const isIconsRefusal = (error: unknown): boolean => {
  if (!isContractError(error) || error.code !== 'unavailable') return false;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return false;
  const { contract, method } = details as Record<string, unknown>;
  return (
    Object.keys(details).length === 2 &&
    contract === 'models/v1' &&
    method === 'icons'
  );
};

/**
 * The SVG of one answering model's icon (its own, else its provider's own), or
 * `null` when the icon is known to be absent: no handle, the window's own
 * stub refusing a `models/v1` without `icons` (a `ContractError` with code
 * `unavailable` and details deep-equal to `{ contract: 'models/v1', method:
 * 'icons' }`), or an answer that names no icon, or a name that is not an own
 * key of its `svgs`. Rejects for every other failure, `unavailable` from the
 * bridge included. Never throws synchronously; never answers `undefined`.
 */
export const readModelIcon = async (
  providerId: string,
  model: string,
): Promise<string | null> => {
  const api = modelsApi;
  if (api === undefined) return null;
  try {
    const { svgs, answers } = await api.icons({
      requests: [{ providerId, models: [model] }],
    });
    const name = answers[0]?.models[0];
    if (name === undefined || name === null) return null;
    return Object.hasOwn(svgs, name) ? (svgs[name] ?? null) : null;
  } catch (error) {
    if (isIconsRefusal(error)) return null;
    throw error;
  }
};
