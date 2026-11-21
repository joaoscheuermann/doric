// The rules of `settings.provider.field` (bundle isolation 6(a), D14): which
// items are drawn, which one stands in for a field, and the `view` its element
// is set. Pure, so it runs under `tsconfig.spec.json`.

import type { RegionEntry } from 'bundle/contracts';

import type {
  ProviderFieldItemProps,
  ProviderFieldView,
} from '../../contracts/index.js';
import type { Credential, ProviderDraft, ProviderField } from './config.js';

/** One drawable item of `settings.provider.field`. */
export interface ProviderFieldEntry {
  readonly id: string;
  readonly tag: string;
  readonly props: ProviderFieldItemProps;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

/** The item's props when both are non-empty strings, else `undefined`. */
export const providerFieldItemProps = (
  props: unknown,
): ProviderFieldItemProps | undefined => {
  if (!isRecord(props)) return undefined;
  const { kind, field } = props;
  return isFilled(kind) && isFilled(field) ? { kind, field } : undefined;
};

/** The region's items whose props pass the guard, in region order. */
export const providerFieldEntries = (
  items: readonly RegionEntry[],
): readonly ProviderFieldEntry[] =>
  items.flatMap((item) => {
    const props = providerFieldItemProps(item.props);
    return props === undefined ? [] : [{ id: item.id, tag: item.tag, props }];
  });

/** The first entry for `kind` and `field`, or `undefined`. */
export const fieldEntryFor = (
  entries: readonly ProviderFieldEntry[],
  kind: string,
  field: string,
): ProviderFieldEntry | undefined =>
  entries.find(
    (entry) => entry.props.kind === kind && entry.props.field === field,
  );

/**
 * The element's `view`. `problem` is set only where today's sign-in message stood
 * in for the page's issue before 1.12.0: the provider has an
 * id, `draftIssue` is defined, and a required field's value is empty
 * (`missing`) or, for a `secret` field, names no stored `API_TOKEN` credential
 * (`unknown`). An optional field that is empty has no problem.
 */
export const providerFieldView = ({
  draft,
  field,
  credentials,
  draftIssue,
}: {
  readonly draft: ProviderDraft;
  readonly field: ProviderField;
  readonly credentials: readonly Credential[];
  readonly draftIssue: string | undefined;
}): ProviderFieldView => {
  const value = draft.configuration[field.key] ?? '';
  const empty = value.trim() === '';
  const stored =
    field.kind === 'secret' && !empty
      ? credentials.find(
          (credential) =>
            credential.kind === 'API_TOKEN' && credential.id === value,
        )
      : undefined;
  const problem =
    draft.id.trim() === '' || draftIssue === undefined
      ? undefined
      : empty
        ? field.required
          ? 'missing'
          : undefined
        : field.kind === 'secret' && stored === undefined
          ? 'unknown'
          : undefined;
  return {
    kind: draft.kind,
    field: field.key,
    ...(value === '' ? {} : { value }),
    ...(stored === undefined ? {} : { label: stored.name }),
    ...(problem === undefined ? {} : { problem }),
  };
};
