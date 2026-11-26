import { isModelIconName, type ModelIconName } from 'llms';

/** How long the core waits for one provider record's `icons`. */
export const PROVIDER_ICONS_DEADLINE_MS = 1000;

/** One request's answer by icon name, before the names become SVGs. */
export interface IconAnswer {
  readonly provider?: ModelIconName;
  readonly models: readonly (ModelIconName | null)[];
}

/** A name of the set, or none for anything else. */
const knownIcon = (name: string | null | undefined): ModelIconName | null =>
  name !== null && name !== undefined && isModelIconName(name) ? name : null;

/**
 * A record's choice for `count` models as names of the set: each model wears
 * its own icon, else the provider's; `undefined` for no choice or another count.
 */
export const iconAnswerOf = (
  choice:
    | {
        readonly provider?: string | null;
        readonly models: readonly (string | null)[];
      }
    | undefined,
  count: number,
): IconAnswer | undefined => {
  if (choice === undefined || choice.models.length !== count) return undefined;

  const provider = knownIcon(choice.provider);
  const models = choice.models.map((name) => knownIcon(name) ?? provider);

  return provider === null ? { models } : { provider, models };
};
