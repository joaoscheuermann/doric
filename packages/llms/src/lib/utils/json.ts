import { isRecord } from 'tool';

export const asRecord = (
  value: unknown,
): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);

export const stringField = (
  record: Record<string, unknown>,
  key: string,
): string | undefined =>
  typeof record[key] === 'string' ? record[key] : undefined;

export const numberField = (
  record: Record<string, unknown>,
  key: string,
): number | undefined =>
  typeof record[key] === 'number' && Number.isFinite(record[key])
    ? record[key]
    : undefined;

export const arrayField = (
  record: Record<string, unknown>,
  key: string,
): readonly unknown[] => (Array.isArray(record[key]) ? record[key] : []);

export const recordField = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => asRecord(record[key]);
