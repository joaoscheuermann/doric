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
  limit_exceeded: Code.ResourceExhausted,
  unknown_contract: Code.Unimplemented,
  unsupported_operation: Code.Unimplemented,
  unavailable: Code.Unavailable,
  generation_lost: Code.Unavailable,
  unavailable_tool: Code.Unavailable,
  credential_storage_unavailable: Code.Unavailable,
  disconnected: Code.Unavailable,
  storage_not_migrated: Code.Unavailable,
  internal: Code.Internal,
  invalid_output: Code.Internal,
  protocol_error: Code.Internal,
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
    (code) => !(code in errorTable) && !retired.includes(code),
  );

  assert.deepEqual(missing, []);

  for (const code of contractErrorCodes) {
    const expected = errorTable[code] ?? Code.FailedPrecondition;

    assert.equal(grpcCodeOf(code), expected, code);
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
