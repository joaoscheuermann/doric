import { create, type JsonObject, type JsonValue } from '@bufbuild/protobuf';
import { type Any, anyPack, anyUnpack } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';

import { ContractError } from './error.js';
import {
  type ErrorDetails,
  ErrorDetailsSchema,
} from './gen/doric/platform/v1/control_pb.js';
import {
  type ErrorInfo,
  ErrorInfoSchema,
} from './gen/google/rpc/error_details_pb.js';
import { type Status, StatusSchema } from './gen/google/rpc/status_pb.js';

/** The `google.rpc.ErrorInfo.domain` under which a Doric error code travels (D3). */
export const contractErrorDomain = 'doric';

/**
 * Codes that stay in `contractErrorCodes` for readers but are no longer raised:
 * nothing is local any more, and a missing `doric-provider` on a `many`
 * contract is `invalid_input`. They have no row in the error table, so
 * `grpcCodeOf` maps them to the default, `FailedPrecondition`.
 */
export const retiredErrorCodes = [
  'local_only',
  'many_contract_use',
  'cardinality_mismatch',
] as const;

export type RetiredErrorCode = (typeof retiredErrorCodes)[number];

/** The rows of the error table: each gRPC code with the Doric codes it carries. */
const errorTable: ReadonlyArray<readonly [Code, readonly string[]]> = [
  [
    Code.InvalidArgument,
    [
      'invalid_input',
      'invalid_scope',
      'invalid_stream',
      'invalid_index_value',
      'credential_invalid',
    ],
  ],
  [Code.Unauthenticated, ['invalid_instance_token', 'instance_revoked']],
  [
    Code.PermissionDenied,
    ['undeclared_requirement', 'undeclared_provide', 'not_owner'],
  ],
  [
    Code.NotFound,
    [
      'unknown_type',
      'unknown_settings',
      'unknown_event',
      'unknown_kind',
      'settings_missing',
      'credential_missing',
      'not_found',
      'unknown_command',
      'unknown_provider',
      'unknown_session',
      'unknown_lease',
    ],
  ],
  [
    Code.AlreadyExists,
    [
      'registration_conflict',
      'duplicate_tool',
      'duplicate_skill',
      'credential_name_taken',
      'duplicate_credential_kind',
      'provider_conflict',
      'route_conflict',
    ],
  ],
  [
    Code.Aborted,
    [
      'revision_conflict',
      'sequence_conflict',
      'unique_conflict',
      'settings_conflict',
      'condition_failed',
    ],
  ],
  [Code.ResourceExhausted, ['limit_exceeded']],
  [Code.Unimplemented, ['unknown_contract', 'unsupported_operation']],
  [
    Code.Unavailable,
    [
      'unavailable',
      'generation_lost',
      'unavailable_tool',
      'credential_storage_unavailable',
      'disconnected',
      'storage_not_migrated',
    ],
  ],
  [Code.Internal, ['internal', 'invalid_output', 'protocol_error']],
];

const grpcCodes: ReadonlyMap<string, Code> = new Map(
  errorTable.flatMap(([grpc, codes]) => codes.map((code) => [code, grpc])),
);

/** Whether a value is a JSON value, acyclic, so a `google.protobuf.Value` can hold it. */
const isJsonValue = (value: unknown, path: ReadonlySet<object>): boolean => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }

  if (typeof value !== 'object' || path.has(value)) {
    return false;
  }

  const inner = new Set(path).add(value);

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, inner));
  }

  return isJsonObject(value, inner);
};

/** Whether a value is a plain JSON object, so a `google.protobuf.Struct` can hold it. */
const isJsonObject = (
  value: unknown,
  path: ReadonlySet<object> = new Set(),
): value is JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;

  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  const inner = new Set(path).add(value);

  return Object.values(value).every((item: unknown) =>
    isJsonValue(item, inner),
  );
};

/** The ErrorInfo and, for JSON-object details, the ErrorDetails of an error. */
const detailMessages = (
  e: ContractError,
): { info: ErrorInfo; details?: ErrorDetails } => {
  const info = create(ErrorInfoSchema, {
    reason: e.code,
    domain: contractErrorDomain,
  });

  return isJsonObject(e.details)
    ? { info, details: create(ErrorDetailsSchema, { details: e.details }) }
    : { info };
};

/** The ContractError the decoded details of a Status or ConnectError describe. */
const contractErrorOf = (
  message: string,
  infos: readonly ErrorInfo[],
  details: readonly ErrorDetails[],
): ContractError => {
  const info = infos.find((item) => item.domain === contractErrorDomain);

  if (info === undefined) {
    return new ContractError('internal', message);
  }

  const json: JsonValue | undefined = details.find(
    (item) => item.details !== undefined,
  )?.details;

  return new ContractError(info.reason, message, json);
};

/** Unpacks an Any of the given schema; one that fails to decode yields undefined. */
const unpack = <T>(
  any: Any,
  read: (any: Any) => T | undefined,
): T | undefined => {
  try {
    return read(any);
  } catch {
    return undefined;
  }
};

/**
 * The gRPC code for a Doric error code, by the table of the design's section 3,
 * "Errors". Accepts any string, since codes are an open set; a code without a
 * row, a retired code included, yields `Code.FailedPrecondition`. Total and
 * pure: never throws, and the same code always yields the same gRPC code. The
 * Doric code stays authoritative; the gRPC code is for gRPC tooling.
 */
export const grpcCodeOf = (code: string): Code =>
  grpcCodes.get(code) ?? Code.FailedPrecondition;

/**
 * Encodes a ContractError as the `google.rpc.Status` that ends a call: `code`
 * is `grpcCodeOf(e.code)`, `message` is `e.message`, and `details` hold one
 * `google.rpc.ErrorInfo { reason: e.code, domain: "doric" }` and, when
 * `e.details` is defined, one `doric.platform.v1.ErrorDetails` carrying them
 * as a `google.protobuf.Struct`. Never throws.
 */
export const toStatus = (e: ContractError): Status => {
  const { info, details } = detailMessages(e);

  return create(StatusSchema, {
    code: grpcCodeOf(e.code),
    message: e.message,
    details: [
      anyPack(ErrorInfoSchema, info),
      ...(details === undefined ? [] : [anyPack(ErrorDetailsSchema, details)]),
    ],
  });
};

/**
 * Rebuilds the ContractError a `toStatus` encoded: `fromStatus(toStatus(e))`
 * has the same `code`, `message` and `details` as `e` for JSON details. The
 * code is the `reason` of the first `ErrorInfo` whose domain is `doric`; a
 * Status without one (a non-Doric peer, a transport failure) yields code
 * `internal` with the Status message. Details that fail to decode are
 * dropped. Never throws.
 */
export const fromStatus = (s: Status): ContractError =>
  contractErrorOf(
    s.message,
    s.details.flatMap(
      (any) => unpack(any, (item) => anyUnpack(item, ErrorInfoSchema)) ?? [],
    ),
    s.details.flatMap(
      (any) => unpack(any, (item) => anyUnpack(item, ErrorDetailsSchema)) ?? [],
    ),
  );

/**
 * The ConnectError a Connect handler throws for a ContractError: code
 * `grpcCodeOf(e.code)`, raw message `e.message`, and as outgoing details the
 * same ErrorInfo and ErrorDetails `toStatus` writes, so any peer reads the
 * same `google.rpc.Status`. Never throws.
 */
export const toConnectError = (e: ContractError): ConnectError => {
  const { info, details } = detailMessages(e);

  return new ConnectError(e.message, grpcCodeOf(e.code), undefined, [
    { desc: ErrorInfoSchema, value: info },
    ...(details === undefined
      ? []
      : [{ desc: ErrorDetailsSchema, value: details }]),
  ]);
};

/**
 * Rebuilds the ContractError from a ConnectError a Connect client received:
 * `fromConnectError(toConnectError(e))` has the same `code`, `message` and
 * `details` as `e` for JSON details. Without a Doric ErrorInfo detail the code
 * is `internal` and the message the ConnectError's raw message. Never throws.
 */
export const fromConnectError = (e: ConnectError): ContractError =>
  contractErrorOf(
    e.rawMessage,
    e.findDetails(ErrorInfoSchema),
    e.findDetails(ErrorDetailsSchema),
  );
