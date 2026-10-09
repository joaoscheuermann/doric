/** Error codes the platform raises; an open set, so unknown codes are generic. */
export const contractErrorCodes = [
  'internal',
  'invalid_input',
  'invalid_output',
  'unavailable',
  'undeclared_requirement',
  'undeclared_provide',
  'many_contract_use',
  'cardinality_mismatch',
  'provider_conflict',
  'contract_mismatch',
  'local_only',
  'not_owner',
  'registration_conflict',
  'duplicate_tool',
  'duplicate_skill',
  'unavailable_tool',
] as const;

export type ContractErrorCode = (typeof contractErrorCodes)[number];

/** The error every contract boundary speaks: a stable `code`, a message and details. */
export class ContractError extends Error {
  override readonly name = 'ContractError';
  readonly code: string;
  readonly details?: unknown;

  constructor(
    code: ContractErrorCode | (string & {}),
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.code = code;

    if (details !== undefined) {
      this.details = details;
    }
  }
}

/** Detects a ContractError by name and code, never by `instanceof`. */
export const isContractError = (value: unknown): value is ContractError =>
  typeof value === 'object' &&
  value !== null &&
  (value as { name?: unknown }).name === 'ContractError' &&
  typeof (value as { code?: unknown }).code === 'string' &&
  typeof (value as { message?: unknown }).message === 'string';

/** Keeps a ContractError; any other value becomes code `internal` with its message. */
export const toContractError = (value: unknown): ContractError => {
  if (isContractError(value)) {
    return value;
  }

  const message =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : 'Internal error.';

  return new ContractError('internal', message);
};
