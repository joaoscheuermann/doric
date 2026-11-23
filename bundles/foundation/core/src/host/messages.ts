// `google.protobuf.Any` values of the routed services ⇄ the JSON `core`
// stores (spec `docs/designs/grpc-processes.md`, "Values" and "Validation").

import {
  type DescMessage,
  fromJson,
  getOption,
  hasOption,
  type JsonValue,
  type Message,
  type Registry,
  toJson,
} from '@bufbuild/protobuf';
import { type Any, anyIs, anyPack, anyUnpack } from '@bufbuild/protobuf/wkt';
import { createValidator } from '@bufbuild/protovalidate';
import { ContractError } from 'bundle/contracts';
import {
  event as eventOption,
  settings as settingsOption,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';

const validator = createValidator();

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether protovalidate accepts `message` as `desc`. */
export const accepts = (desc: DescMessage, message: Message): boolean =>
  validator.validate(desc, message).kind === 'valid';

/**
 * The message `typeName` names in `types` when it carries the option
 * `option` (`settings` or `event` of `doric/platform/v1/options.proto`) with
 * the id `id`. Throws `ContractError` `invalid_input` when the type is
 * unknown, has no such option, or names another id.
 */
export const optionMessage = (
  types: Registry,
  typeName: string,
  option: 'settings' | 'event',
  id: string,
): DescMessage => {
  const desc = types.getMessage(typeName);

  if (desc === undefined) {
    throw new ContractError(
      'invalid_input',
      `The message ${typeName} is not known.`,
      { messageType: typeName },
    );
  }

  const named =
    option === 'settings'
      ? hasOption(desc, settingsOption)
        ? getOption(desc, settingsOption).id
        : undefined
      : hasOption(desc, eventOption)
        ? getOption(desc, eventOption).type
        : undefined;

  if (named !== id) {
    throw new ContractError(
      'invalid_input',
      named === undefined
        ? `The message ${typeName} has no ${option} option.`
        : `The message ${typeName} is the ${option} ${named}, not ${id}.`,
      { messageType: typeName, [option]: id },
    );
  }

  return desc;
};

/**
 * `value`'s message as JSON (`toJson` with `types`, JSON names, fields at
 * their default emitted as 1.x rows hold them), after a check that
 * `value.typeUrl` names `desc` and that protovalidate accepts the message.
 * Throws `ContractError` `invalid_input` with details `{ field: what,
 * typeUrl }` or the violations otherwise.
 */
export const jsonOfAny = (
  value: Any | undefined,
  desc: DescMessage,
  types: Registry,
  what: string,
): JsonValue => {
  if (value === undefined || !anyIs(value, desc)) {
    throw new ContractError(
      'invalid_input',
      `The ${what} is not a ${desc.typeName}.`,
      { field: what, typeUrl: value?.typeUrl ?? '' },
    );
  }

  let message: Message | undefined;

  try {
    message = anyUnpack(value, desc);
  } catch (error) {
    throw new ContractError(
      'invalid_input',
      `The ${what} does not decode as ${desc.typeName}: ${messageOf(error)}`,
      { field: what, typeUrl: value.typeUrl },
    );
  }

  if (message === undefined) {
    throw new ContractError(
      'invalid_input',
      `The ${what} is not a ${desc.typeName}.`,
      { field: what, typeUrl: value.typeUrl },
    );
  }

  const result = validator.validate(desc, message);

  if (result.kind === 'invalid') {
    throw new ContractError(
      'invalid_input',
      `Invalid ${what}: ${result.error.message}`,
      {
        field: what,
        violations: result.violations.map((violation) => violation.toString()),
      },
    );
  }

  if (result.kind === 'error') {
    throw new ContractError(
      'invalid_input',
      `The ${what} cannot be validated: ${result.error.message}`,
      { field: what, typeUrl: value.typeUrl },
    );
  }

  return toJson(desc, message, { registry: types, alwaysEmitImplicit: true });
};

/**
 * The `Any` of `desc` that `json` (a stored value) holds. A field the
 * message lacks is ignored (a 1.x row). Throws `ContractError`
 * `invalid_output` when the JSON is not that message.
 */
export const anyOfJson = (
  json: unknown,
  desc: DescMessage,
  types: Registry,
): Any => {
  try {
    return anyPack(
      desc,
      fromJson(desc, json as JsonValue, {
        registry: types,
        ignoreUnknownFields: true,
      }),
    );
  } catch (error) {
    throw new ContractError(
      'invalid_output',
      `The stored value is not a ${desc.typeName}: ${messageOf(error)}`,
      { messageType: desc.typeName },
    );
  }
};
