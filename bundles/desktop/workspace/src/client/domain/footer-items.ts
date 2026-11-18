// The check of a `workspace.dashboard.footer` item's `props` (spec §8,
// decision O5). Its twin is `account`'s `domain/menu-items.ts`, the same rule
// for `account.menu`: the spec declares each slot's props type in its owner.
// Pure, so it runs under `tsconfig.spec.json`.

import { isContractId } from 'bundle/contracts';

import type { DashboardFooterItemProps } from '../../contracts/index.js';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `props` as `DashboardFooterItemProps`, or `undefined` when they fail the
 * type: `label` is a string, `command` is a contract id, and `input` is
 * absent or a non-null object that is not an array. Unknown extra keys are
 * allowed.
 */
export const footerItemProps = (
  props: unknown,
): DashboardFooterItemProps | undefined => {
  if (!isRecord(props)) return undefined;
  const { label, command, input } = props;
  if (typeof label !== 'string' || !isContractId(command)) return undefined;
  if (input === undefined) return { label, command };
  if (!isRecord(input)) return undefined;
  return { label, command, input };
};
