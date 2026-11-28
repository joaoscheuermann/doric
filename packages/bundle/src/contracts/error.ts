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
  // process envelope
  'generation_lost',
  'protocol_error',
  // storage/v1 and storage.backend/v1
  'revision_conflict',
  'sequence_conflict',
  'unique_conflict',
  'limit_exceeded',
  'unknown_type',
  'invalid_index_value',
  'invalid_stream',
  // settings/v1
  'unknown_settings',
  'settings_missing',
  'settings_conflict',
  // events/v1
  'unknown_event',
  'invalid_scope',
  // secrets/v1 and secrets.backend/v1
  'credential_missing',
  'credential_invalid',
  'credential_name_taken',
  'credential_kind_immutable',
  'credential_ambiguous',
  'credential_storage_unavailable',
  'credential_key_required',
  'credential_unreadable',
  'unknown_kind',
  'duplicate_credential_kind',
  // desktop platform (stage 8)
  'not_found',
  'disconnected',
  'unknown_command',
  // desktop UI (stage 9, D9-18)
  'route_conflict',
  // gRPC processes (phase 2)
  'unknown_contract',
  'unknown_provider',
  'invalid_instance_token',
  'instance_revoked',
  'not_connected',
  'control_stream_open',
  // sandbox/v1 by lease id (phase 3, S44): an unknown, released or other
  // instance's lease (`NOT_FOUND`), and an operation the sandbox does not
  // offer, such as `Start` (`UNIMPLEMENTED`).
  'unknown_lease',
  'unsupported_operation',
  // runtime.workspace/v1 Thread sessions and executor.session/v1 (phase 3, S47/S48): an id that is unknown,
  // ended, or bound to another instance (`NOT_FOUND`).
  'unknown_session',
  // models.provider/v1 (phase 3, S43): a thrown llms provider error, the
  // whole `ProviderError` in `details.providerError`; no row in the error
  // table, so it travels as `FAILED_PRECONDITION`.
  'provider_error',
  // tools/v1 (phase 3, S51): a thrown tool error, the whole `ToolError` in
  // `details.toolError`; no row in the error table, so it travels as
  // `FAILED_PRECONDITION`.
  'tool_error',
  // the public API doric.api.* (phase 3, S60): transport's refusal reasons that
  // have a row in the error table (INVALID_ARGUMENT, NOT_FOUND, UNAVAILABLE,
  // INTERNAL); its other reasons travel as `FAILED_PRECONDITION`.
  'invalid_config',
  'invalid_credential',
  'invalid_provider',
  'invalid_project',
  'invalid_project_color',
  'invalid_thread',
  'invalid_project_path',
  'invalid_execution',
  'invalid_branch',
  'invalid_prompt',
  'invalid_steer',
  'invalid_resume',
  'invalid_rewind',
  'invalid_interrupt',
  'invalid_terminal',
  'invalid_cursor',
  'invalid_size',
  'invalid_credential_id',
  'invalid_project_id',
  'invalid_thread_id',
  'invalid_page',
  'invalid_cwd',
  'invalid_event_cursor',
  'credential_not_found',
  'vm_not_found',
  'project_not_found',
  'project_path_not_found',
  'thread_not_found',
  'prompt_not_found',
  'unknown_prompt',
  'missing',
  'terminal_missing',
  'configuration_rejected',
  'model_catalog_unreadable',
  'compaction_failed',
  'internal_error',
  // storage.kv/v1 and the sqlite engine (phase 4, S74b)
  'condition_failed',
  'storage_path_missing',
  'storage_format_unsupported',
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
