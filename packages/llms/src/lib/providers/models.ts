import type { ReasoningEffort } from '../types/provider.js';
import {
  arrayField,
  asRecord,
  recordField,
  stringField,
} from '../utils/json.js';

/**
 * What an endpoint's model catalog says about one model: what it is called, the
 * reasoning efforts it accepts, and every request parameter it advertises. A
 * catalog that describes a model's reasoning without naming efforts, or that says
 * nothing about it, leaves the set unknown rather than empty, and a model the
 * catalog does not list has no entry at all.
 */
export interface CatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly reasonings: readonly ReasoningEffort[];
  /** Every supported parameter the catalog named, in the order it named them. */
  readonly parameters: readonly string[];
}

/**
 * The models an OpenAI-compatible `/models` answer lists, each with the efforts
 * the catalog names for it. The envelope is the one every OpenAI-shaped endpoint
 * serves; the per-model `reasoning` block is what makes a catalog one that
 * describes its models rather than only listing them.
 */
export const modelCatalog = (
  response: Record<string, unknown>,
): ReadonlyMap<string, CatalogModel> =>
  new Map(
    arrayField(response, 'data')
      .map(asRecord)
      .filter(isRecord)
      .map((entry) => {
        const id = stringField(entry, 'id') ?? '';
        const name = stringField(entry, 'name');

        return [
          id,
          {
            id,
            ...(name === undefined ? {} : { name }),
            reasonings: catalogEfforts(entry),
            parameters: arrayField(entry, 'supported_parameters').filter(
              (value): value is string => typeof value === 'string',
            ),
          },
        ] as const;
      }),
  );

const catalogEfforts = (
  entry: Record<string, unknown>,
): readonly ReasoningEffort[] =>
  arrayField(recordField(entry, 'reasoning') ?? {}, 'supported_efforts').filter(
    (value): value is ReasoningEffort => isReasoningEffort(value),
  );

/**
 * Only the efforts this library names are kept: a catalog value no request can
 * carry is not an effort a model accepts here, so it is dropped rather than
 * stored as an unspellable choice.
 */
const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  value === 'none' ||
  value === 'minimal' ||
  value === 'low' ||
  value === 'medium' ||
  value === 'high' ||
  value === 'xhigh' ||
  value === 'max';

const isRecord = (
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> => value !== undefined;
