import type { z } from 'zod';

import { isDisposable, type MethodSpec } from '../contracts/basic/common.js';
import type { CallScope } from '../contracts/call.js';
import { type CallArg, isCall, isCallOptions } from '../contracts/call.js';
import { ContractError, isContractError } from '../contracts/error.js';
import { bindRegistrant, isRegistrable } from '../contracts/registrable.js';
import { createHopCall } from './call.js';
import type { ProviderRecord } from './directory.js';
import type { Principal } from './principal.js';

interface ZodInternals {
  readonly _zod?: {
    readonly def?: { readonly type?: string; readonly items?: unknown };
  };
}

export const isTupleSchema = (schema: z.ZodType): boolean =>
  (schema as ZodInternals)._zod?.def?.type === 'tuple';

const tupleItems = (schema: z.ZodType): readonly z.ZodType[] =>
  ((schema as ZodInternals)._zod?.def?.items as z.ZodType[] | undefined) ?? [];

interface Normalized {
  readonly input: unknown;
  readonly callArg: CallArg | undefined;
  readonly tuple: boolean;
}

/**
 * Splits stub arguments into the method input and the optional trailing call
 * argument. A trailing Call is always the call argument; trailing call
 * options are the call argument only beyond the tuple length or where the
 * tuple item at that position rejects them.
 */
export const normalizeArguments = (
  schema: z.ZodType,
  args: readonly unknown[],
): Normalized => {
  if (!isTupleSchema(schema)) {
    const candidate = args[1];

    return {
      input: args[0],
      callArg:
        isCall(candidate) || isCallOptions(candidate) ? candidate : undefined,
      tuple: false,
    };
  }

  const items = tupleItems(schema);
  const last = args.at(-1);
  const index = args.length - 1;
  const isCallArgument =
    args.length > 0 &&
    (isCall(last) ||
      (isCallOptions(last) &&
        (args.length > items.length ||
          !(items[index] as z.ZodType).safeParse(last).success)));

  return isCallArgument
    ? { input: args.slice(0, -1), callArg: last as CallArg, tuple: true }
    : { input: [...args], callArg: undefined, tuple: true };
};

const bind = (principal: Principal, value: unknown): unknown =>
  isRegistrable(value) ? value[bindRegistrant](principal.services) : value;

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

const issuesOf = (error: z.ZodError) =>
  error.issues.map(({ code, path, message }) => ({
    code,
    path: path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
    message,
  }));

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : ''}${issue.message}`,
    )
    .join('; ');

/**
 * Codes a provider raises when it refuses a registration (a name already
 * taken, a hooks contract owned by another bundle, an allowed tool the caller
 * did not register...). The activation loop quarantines such a failure as
 * `registration_failed` or `cardinality_mismatch`, not `activate_failed`.
 */
const registrationConflicts: ReadonlySet<string> = new Set([
  'duplicate_tool',
  'duplicate_skill',
  'registration_conflict',
  'not_owner',
  'unavailable_tool',
  'provider_conflict',
  'undeclared_provide',
  'cardinality_mismatch',
  'contract_mismatch',
]);

export interface DispatchTarget {
  readonly contractId: string;
  readonly useScope?: CallScope;
  /** A provider fixed by `whenAvailable`; otherwise resolved per call. */
  readonly pinned?: ProviderRecord;
}

/** One stub call: resolve, bind, validate, hop, invoke, validate, track. */
export const dispatch = (
  principal: Principal,
  target: DispatchTarget,
  method: string,
  args: readonly unknown[],
): unknown => {
  const { runtime } = principal;
  const { contractId } = target;

  if (principal.closed) {
    throw new ContractError(
      'unavailable',
      `Bundle "${principal.bundleId}" is no longer active.`,
    );
  }

  const record = target.pinned ?? runtime.directory.active(contractId);

  if (record === undefined || !runtime.directory.isActive(record)) {
    throw new ContractError(
      'unavailable',
      `No active provider of "${contractId}".`,
      { contract: contractId },
    );
  }

  const spec: MethodSpec | undefined = Object.hasOwn(record.methods, method)
    ? record.methods[method]
    : undefined;

  if (spec === undefined) {
    throw new ContractError(
      'unavailable',
      `Contract "${contractId}" has no method "${method}".`,
      { contract: contractId, method },
    );
  }

  const normalized = normalizeArguments(spec.input, args);
  const input = normalized.tuple
    ? (normalized.input as readonly unknown[]).map((value) =>
        bind(principal, value),
      )
    : bind(principal, normalized.input);
  const parsed = spec.input.safeParse(input);

  if (!parsed.success) {
    throw new ContractError(
      'invalid_input',
      `Invalid input for ${contractId} ${method}: ${describeIssues(parsed.error)}`,
      { contract: contractId, method, issues: issuesOf(parsed.error) },
    );
  }

  const scope = principal.current;
  const call = createHopCall({
    caller: principal.caller,
    useScope: target.useScope,
    arg: normalized.callArg,
    generationSignal: runtime.generationSignal,
    now: runtime.now,
  });
  const settle = (value: unknown): unknown => {
    const checked = spec.output.safeParse(value);

    if (!checked.success) {
      throw new ContractError(
        'invalid_output',
        `Invalid output from ${contractId} ${method} (bundle "${record.bundleId}"): ${describeIssues(checked.error)}`,
        { contract: contractId, method, issues: issuesOf(checked.error) },
      );
    }

    if (isDisposable(value)) {
      scope.track(value);
    }

    // The original value, never the parsed copy.
    return value;
  };
  const noteConflict = (error: unknown): never => {
    if (isContractError(error) && registrationConflicts.has(error.code)) {
      principal.noteRegistrationError(error);
    }

    throw error;
  };
  let result: unknown;

  try {
    result = record.invoke(method, parsed.data, call);
  } catch (error) {
    noteConflict(error);
  }

  return isPromiseLike(result)
    ? Promise.resolve(result).then(settle, noteConflict)
    : settle(result);
};

const reserved = new Set([
  'then',
  'toJSON',
  'constructor',
  'valueOf',
  'toString',
]);

/** A late-binding stub: every method name dispatches to the provider on call. */
export const createStub = <Api>(
  principal: Principal,
  target: DispatchTarget,
): Api => {
  const methods = new Map<string, (...args: unknown[]) => unknown>();

  return new Proxy(Object.create(null) as object, {
    get: (_target, property) => {
      if (typeof property !== 'string' || reserved.has(property)) {
        return undefined;
      }

      let method = methods.get(property);

      if (method === undefined) {
        method = (...args: unknown[]) =>
          dispatch(principal, target, property, args);
        methods.set(property, method);
      }

      return method;
    },
  }) as Api;
};
