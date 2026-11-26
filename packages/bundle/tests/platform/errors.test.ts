import assert from 'node:assert/strict';
import test from 'node:test';

import { create } from '@bufbuild/protobuf';
import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { AnySchema } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';

import { StatusSchema } from '../../src/contracts/gen/google/rpc/status_pb.js';
import {
  ContractError,
  contractErrorCodes,
  contractErrorDomain,
  fromConnectError,
  fromStatus,
  grpcCodeOf,
  quarantineCodes,
  retiredErrorCodes,
  toConnectError,
  toStatus,
} from '../../src/contracts/index.js';

/**
 * The error table of the design's section 3, "Errors": each Doric code with
 * the gRPC code it ends a call with. Codes of later phases are listed too.
 */
const errorTable: Readonly<Record<string, Code>> = {
  invalid_input: Code.InvalidArgument,
  invalid_scope: Code.InvalidArgument,
  invalid_stream: Code.InvalidArgument,
  invalid_index_value: Code.InvalidArgument,
  credential_invalid: Code.InvalidArgument,
  invalid_instance_token: Code.Unauthenticated,
  instance_revoked: Code.Unauthenticated,
  undeclared_requirement: Code.PermissionDenied,
  undeclared_provide: Code.PermissionDenied,
  not_owner: Code.PermissionDenied,
  unknown_type: Code.NotFound,
  unknown_settings: Code.NotFound,
  unknown_event: Code.NotFound,
  unknown_kind: Code.NotFound,
  settings_missing: Code.NotFound,
  credential_missing: Code.NotFound,
  not_found: Code.NotFound,
  unknown_command: Code.NotFound,
  unknown_provider: Code.NotFound,
  unknown_session: Code.NotFound,
  unknown_lease: Code.NotFound,
  registration_conflict: Code.AlreadyExists,
  duplicate_tool: Code.AlreadyExists,
  duplicate_skill: Code.AlreadyExists,
  credential_name_taken: Code.AlreadyExists,
  duplicate_credential_kind: Code.AlreadyExists,
  provider_conflict: Code.AlreadyExists,
  route_conflict: Code.AlreadyExists,
  revision_conflict: Code.Aborted,
  sequence_conflict: Code.Aborted,
  unique_conflict: Code.Aborted,
  settings_conflict: Code.Aborted,
  condition_failed: Code.Aborted,
  contract_mismatch: Code.FailedPrecondition,
  credential_kind_immutable: Code.FailedPrecondition,
  credential_ambiguous: Code.FailedPrecondition,
  credential_key_required: Code.FailedPrecondition,
  credential_unreadable: Code.FailedPrecondition,
  not_connected: Code.FailedPrecondition,
  control_stream_open: Code.FailedPrecondition,
  storage_path_missing: Code.FailedPrecondition,
  storage_format_unsupported: Code.FailedPrecondition,
  provider_error: Code.FailedPrecondition,
  tool_error: Code.FailedPrecondition,
  limit_exceeded: Code.ResourceExhausted,
  unknown_contract: Code.Unimplemented,
  unsupported_operation: Code.Unimplemented,
  unavailable: Code.Unavailable,
  generation_lost: Code.Unavailable,
  credential_storage_unavailable: Code.Unavailable,
  disconnected: Code.Unavailable,
  storage_not_migrated: Code.Unavailable,
  internal: Code.Internal,
  invalid_output: Code.Internal,
  protocol_error: Code.Internal,
  replay_failed: Code.Internal,
};

/**
 * The public API's rows (S60 §2.2 and §5, Q2): `transport`'s refusal reasons
 * with the gRPC code each ends a call with. Every other API reason
 * (`project_active`, `thread_busy`, …) has no row: `FAILED_PRECONDITION`.
 */
const apiRows: Readonly<Record<string, Code>> = {
  // 422 bodies
  invalid_config: Code.InvalidArgument,
  invalid_credential: Code.InvalidArgument,
  invalid_provider: Code.InvalidArgument,
  invalid_project: Code.InvalidArgument,
  invalid_project_color: Code.InvalidArgument,
  invalid_thread: Code.InvalidArgument,
  invalid_project_path: Code.InvalidArgument,
  invalid_execution: Code.InvalidArgument,
  invalid_branch: Code.InvalidArgument,
  invalid_prompt: Code.InvalidArgument,
  invalid_steer: Code.InvalidArgument,
  invalid_resume: Code.InvalidArgument,
  invalid_rewind: Code.InvalidArgument,
  invalid_interrupt: Code.InvalidArgument,
  invalid_terminal: Code.InvalidArgument,
  invalid_cursor: Code.InvalidArgument,
  invalid_size: Code.InvalidArgument,
  // 400 path ids and queries
  invalid_credential_id: Code.InvalidArgument,
  invalid_project_id: Code.InvalidArgument,
  invalid_thread_id: Code.InvalidArgument,
  invalid_page: Code.InvalidArgument,
  invalid_cwd: Code.InvalidArgument,
  invalid_event_cursor: Code.InvalidArgument,
  // 404
  credential_not_found: Code.NotFound,
  vm_not_found: Code.NotFound,
  project_not_found: Code.NotFound,
  project_path_not_found: Code.NotFound,
  thread_not_found: Code.NotFound,
  prompt_not_found: Code.NotFound,
  unknown_prompt: Code.NotFound,
  missing: Code.NotFound,
  terminal_missing: Code.NotFound,
  // 503 and 502
  configuration_rejected: Code.Unavailable,
  model_catalog_unreadable: Code.Unavailable,
  compaction_failed: Code.Unavailable,
  // 500
  internal_error: Code.Internal,
};

const errorInfoTypeUrl = 'type.googleapis.com/google.rpc.ErrorInfo';

interface ErrorInfoFields {
  readonly reason: string;
  readonly domain: string;
}

/** Reads `reason` (field 1) and `domain` (field 2) of a `google.rpc.ErrorInfo`. */
const readErrorInfo = (bytes: Uint8Array): ErrorInfoFields => {
  const reader = new BinaryReader(bytes);
  let reason = '';
  let domain = '';

  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();

    if (field === 1) {
      reason = reader.string();
    } else if (field === 2) {
      domain = reader.string();
    } else {
      reader.skip(wireType);
    }
  }

  return { reason, domain };
};

/** Encodes a `google.rpc.ErrorInfo` with the given reason and domain. */
const writeErrorInfo = ({ reason, domain }: ErrorInfoFields): Uint8Array =>
  new BinaryWriter()
    .tag(1, WireType.LengthDelimited)
    .string(reason)
    .tag(2, WireType.LengthDelimited)
    .string(domain)
    .finish();

const jsonDetails = {
  contract: 'storage/v1',
  attempts: 3,
  retry: false,
  nested: { list: [1, 'two', null, { deep: true }], empty: {} },
};

void test('one code of each family of the error table maps to its gRPC code', () => {
  const families: ReadonlyArray<readonly [string, Code]> = [
    ['invalid_input', Code.InvalidArgument],
    ['invalid_instance_token', Code.Unauthenticated],
    ['undeclared_requirement', Code.PermissionDenied],
    ['not_found', Code.NotFound],
    ['registration_conflict', Code.AlreadyExists],
    ['revision_conflict', Code.Aborted],
    ['contract_mismatch', Code.FailedPrecondition],
    ['limit_exceeded', Code.ResourceExhausted],
    ['unknown_contract', Code.Unimplemented],
    ['unavailable', Code.Unavailable],
    ['internal', Code.Internal],
  ];

  for (const [code, grpc] of families) {
    assert.equal(grpcCodeOf(code), grpc, code);
  }
});

void test('replay_failed (a WatchThread snapshot that cannot be read) is in the Internal row', () => {
  assert.equal(grpcCodeOf('replay_failed'), Code.Internal);

  const sent = toConnectError(
    new ContractError('replay_failed', 'The snapshot could not be read.'),
  );
  const rebuilt = fromConnectError(sent);

  assert.equal(sent.code, Code.Internal);
  assert.equal(rebuilt.code, 'replay_failed');
  assert.equal(rebuilt.message, 'The snapshot could not be read.');
});

void test('an unknown code maps to FAILED_PRECONDITION', () => {
  assert.equal(grpcCodeOf('mcp_server_failed'), Code.FailedPrecondition);
  assert.equal(grpcCodeOf(''), Code.FailedPrecondition);
});

void test('each retired code maps to FAILED_PRECONDITION', () => {
  assert.deepEqual([...retiredErrorCodes].sort(), [
    'cardinality_mismatch',
    'local_only',
    'many_contract_use',
  ]);

  for (const code of retiredErrorCodes) {
    assert.equal(grpcCodeOf(code), Code.FailedPrecondition, code);
  }
});

void test('every code of contractErrorCodes is in a row of the error table or retired', () => {
  const retired: readonly string[] = retiredErrorCodes;
  const missing = contractErrorCodes.filter(
    (code) =>
      !(code in errorTable) && !(code in apiRows) && !retired.includes(code),
  );

  assert.deepEqual(missing, []);

  for (const code of contractErrorCodes) {
    const expected =
      errorTable[code] ?? apiRows[code] ?? Code.FailedPrecondition;

    assert.equal(grpcCodeOf(code), expected, code);
  }
});

void test('S60a E1: each reason of the public API rows maps to its gRPC code', () => {
  assert.equal(Object.keys(apiRows).length, 36);
  assert.equal(
    Object.entries(apiRows).filter(
      ([code, grpc]) =>
        code.startsWith('invalid_') && grpc === Code.InvalidArgument,
    ).length,
    23,
  );

  const wrong = Object.entries(apiRows)
    .filter(([code, grpc]) => grpcCodeOf(code) !== grpc)
    .map(
      ([code, grpc]) => `${code}: ${Code[grpcCodeOf(code)]}, not ${Code[grpc]}`,
    );

  assert.deepEqual(wrong, []);
});

void test('S60a E1: toStatus ends an API refusal with its row code and keeps the reason and message', () => {
  const status = toStatus(
    new ContractError('project_not_found', 'The project does not exist.'),
  );
  const rebuilt = fromStatus(status);

  assert.equal(status.code, Code.NotFound);
  assert.equal(rebuilt.code, 'project_not_found');
  assert.equal(rebuilt.message, 'The project does not exist.');
});

void test('S60a E2: every reason of the public API rows is a ContractErrorCode', () => {
  const codes: readonly string[] = contractErrorCodes;
  const missing = Object.keys(apiRows).filter((code) => !codes.includes(code));

  assert.deepEqual(missing, []);
});

void test('S60a E3: credential_name_taken stays ALREADY_EXISTS and invalid_prompt is INVALID_ARGUMENT (Q2)', () => {
  assert.equal(grpcCodeOf('credential_name_taken'), Code.AlreadyExists);
  assert.equal(
    grpcCodeOf('credential_kind_immutable'),
    Code.FailedPrecondition,
  );
  assert.equal(grpcCodeOf('invalid_prompt'), Code.InvalidArgument);
});

void test('S60a: API reasons without a row stay FAILED_PRECONDITION', () => {
  for (const code of [
    'credential_referenced',
    'vm_ssh_unavailable',
    'project_active',
    'project_files_unavailable',
    'project_resources_unavailable',
    'project_ssh_unavailable',
    'thread_busy',
    'branch_refused',
    'compaction_refused',
    'terminal_unavailable',
    'conflict',
    'not_editable',
    'inactive',
    'forbidden',
    'project_files_expired',
    'project_ssh_expired',
  ]) {
    assert.equal(grpcCodeOf(code), Code.FailedPrecondition, code);
  }
});

void test('toStatus carries the gRPC code, the message and a Doric ErrorInfo', () => {
  const status = toStatus(
    new ContractError('not_found', 'Thread t1 is missing', jsonDetails),
  );

  assert.equal(status.code, Code.NotFound);
  assert.equal(status.message, 'Thread t1 is missing');

  const infos = status.details.filter(
    (detail) => detail.typeUrl === errorInfoTypeUrl,
  );

  assert.equal(infos.length, 1);
  assert.deepEqual(readErrorInfo((infos[0] as { value: Uint8Array }).value), {
    reason: 'not_found',
    domain: 'doric',
  });
  assert.equal(contractErrorDomain, 'doric');
});

void test('code, message and JSON details survive toStatus and fromStatus', () => {
  const error = new ContractError(
    'revision_conflict',
    'Revision 4 is not the latest',
    jsonDetails,
  );
  const rebuilt = fromStatus(toStatus(error));

  assert.equal(rebuilt.name, 'ContractError');
  assert.equal(rebuilt.code, 'revision_conflict');
  assert.equal(rebuilt.message, 'Revision 4 is not the latest');
  assert.deepEqual(rebuilt.details, jsonDetails);
});

void test('an error without details round-trips through a Status without details', () => {
  const rebuilt = fromStatus(
    toStatus(new ContractError('unknown_contract', 'No provider of x/v1')),
  );

  assert.equal(rebuilt.code, 'unknown_contract');
  assert.equal(rebuilt.message, 'No provider of x/v1');
  assert.equal(rebuilt.details, undefined);
});

void test('an unknown code keeps its code through a Status', () => {
  const rebuilt = fromStatus(
    toStatus(new ContractError('mcp_server_failed', 'The server exited')),
  );

  assert.equal(rebuilt.code, 'mcp_server_failed');
  assert.equal(rebuilt.message, 'The server exited');
});

void test('a Status without an ErrorInfo yields internal with its message', () => {
  const rebuilt = fromStatus(
    create(StatusSchema, {
      code: Code.Unavailable,
      message: 'connection reset',
    }),
  );

  assert.equal(rebuilt.code, 'internal');
  assert.equal(rebuilt.message, 'connection reset');
});

void test('a Status whose ErrorInfo has another domain yields internal', () => {
  const rebuilt = fromStatus(
    create(StatusSchema, {
      code: Code.NotFound,
      message: 'no such bucket',
      details: [
        create(AnySchema, {
          typeUrl: errorInfoTypeUrl,
          value: writeErrorInfo({
            reason: 'BUCKET_MISSING',
            domain: 'storage.example.com',
          }),
        }),
      ],
    }),
  );

  assert.equal(rebuilt.code, 'internal');
  assert.equal(rebuilt.message, 'no such bucket');
});

void test('toConnectError carries the gRPC code and the raw message', () => {
  const error = toConnectError(
    new ContractError('limit_exceeded', 'The message is over 4 MiB'),
  );

  assert.equal(error.code, Code.ResourceExhausted);
  assert.equal(error.rawMessage, 'The message is over 4 MiB');
});

void test('code, message and JSON details survive toConnectError and fromConnectError', () => {
  const error = new ContractError(
    'undeclared_requirement',
    'chat does not require storage/v1',
    jsonDetails,
  );
  const rebuilt = fromConnectError(toConnectError(error));

  assert.equal(rebuilt.name, 'ContractError');
  assert.equal(rebuilt.code, 'undeclared_requirement');
  assert.equal(rebuilt.message, 'chat does not require storage/v1');
  assert.deepEqual(rebuilt.details, jsonDetails);
});

void test('the sandbox lease codes travel as NOT_FOUND and UNIMPLEMENTED and come back unchanged', () => {
  const cases: ReadonlyArray<readonly [string, Code]> = [
    ['unknown_lease', Code.NotFound],
    ['unsupported_operation', Code.Unimplemented],
  ];

  for (const [code, grpc] of cases) {
    const sent = toConnectError(new ContractError(code, `${code} message`));
    const rebuilt = fromConnectError(sent);

    assert.equal(sent.code, grpc, code);
    assert.equal(rebuilt.code, code);
    assert.equal(rebuilt.message, `${code} message`);
  }
});

void test('unknown_session is a platform code that travels as NOT_FOUND and comes back unchanged', () => {
  const codes: readonly string[] = contractErrorCodes;
  const sent = toConnectError(
    new ContractError('unknown_session', 'No Thread session s-1.'),
  );
  const rebuilt = fromConnectError(sent);

  assert.ok(codes.includes('unknown_session'));
  assert.equal(sent.code, Code.NotFound);
  assert.equal(rebuilt.code, 'unknown_session');
  assert.equal(rebuilt.message, 'No Thread session s-1.');
});

void test('S51a A4: tool_error is a platform code without a row that travels as FAILED_PRECONDITION and comes back with details.toolError', () => {
  const codes: readonly string[] = contractErrorCodes;
  const toolError = {
    code: 'invalid_output',
    message: 'm',
    toolName: 't',
    issues: [{ path: 'a', message: 'x' }],
  };
  const sent = toConnectError(
    new ContractError('tool_error', 'm', { toolError }),
  );
  const rebuilt = fromConnectError(sent);

  assert.ok(codes.includes('tool_error'));
  assert.equal(sent.code, Code.FailedPrecondition);
  assert.equal(rebuilt.code, 'tool_error');
  assert.equal(rebuilt.message, 'm');
  assert.deepEqual(rebuilt.details, { toolError });
});

void test('a ConnectError without a Doric ErrorInfo yields internal with its raw message', () => {
  const plain = new ConnectError('upstream connect error', Code.Unavailable);
  const foreign = new ConnectError('no such bucket', Code.NotFound);

  foreign.details = [
    {
      type: 'google.rpc.ErrorInfo',
      value: writeErrorInfo({
        reason: 'BUCKET_MISSING',
        domain: 'storage.example.com',
      }),
    },
  ];

  const fromPlain = fromConnectError(plain);
  const fromForeign = fromConnectError(foreign);

  assert.equal(fromPlain.code, 'internal');
  assert.equal(fromPlain.message, 'upstream connect error');
  assert.equal(fromForeign.code, 'internal');
  assert.equal(fromForeign.message, 'no such bucket');
});

void test('the five quarantine codes of the gRPC processes are present', () => {
  const codes: readonly string[] = quarantineCodes;

  for (const code of [
    'invalid_bundle',
    'health_timeout',
    'process_failed',
    'duplicate_http_prefix',
    'unreachable_dependency',
  ]) {
    assert.ok(codes.includes(code), code);
  }
});

void test('the six error codes of the gRPC processes are present', () => {
  const codes: readonly string[] = contractErrorCodes;

  for (const code of [
    'unknown_contract',
    'unknown_provider',
    'invalid_instance_token',
    'instance_revoked',
    'not_connected',
    'control_stream_open',
  ]) {
    assert.ok(codes.includes(code), code);
  }
});
