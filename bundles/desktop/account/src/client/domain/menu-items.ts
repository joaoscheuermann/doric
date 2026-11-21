// The check of an `account.menu` item's `props` (spec §8, decision O3). Pure,
// so it runs under `tsconfig.spec.json`.

import { isContractId } from 'bundle/contracts';

import type { AccountMenuItemProps } from '../../contracts/index.js';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `props` as `AccountMenuItemProps`, or `undefined` when they fail the type
 * (decision O3): `label` is a string, `command` is a contract id, and `input`
 * is absent or a non-null object that is not an array. Unknown extra keys
 * are allowed.
 */
export const menuItemProps = (
  props: unknown,
): AccountMenuItemProps | undefined => {
  if (!isRecord(props)) return undefined;
  const { label, command, input } = props;
  if (typeof label !== 'string' || !isContractId(command)) return undefined;
  if (input === undefined) return { label, command };
  if (!isRecord(input)) return undefined;
  return { label, command, input };
};
