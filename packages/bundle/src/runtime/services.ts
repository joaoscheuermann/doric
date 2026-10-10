import type { HooksProvider } from '../contracts/basic/hooks.js';
import {
  basicContractSpec,
  isBasicContract,
} from '../contracts/basic/index.js';
import type { Call, CallScope } from '../contracts/call.js';
import type {
  Cleanup,
  Disposable,
  ProviderInfo,
  Services,
} from '../contracts/context.js';
import {
  type AnyServiceDefinition,
  isServiceDefinition,
  isServiceRef,
} from '../contracts/define.js';
import { ContractError, isContractError } from '../contracts/error.js';
import { isPlatformContract } from '../contracts/ids.js';
import type { AnyServiceRef } from '../contracts/types.js';
import type { ProviderRecord } from './directory.js';
import { createStub, type DispatchTarget } from './dispatch.js';
import { createHooksFacade } from './facades.js';
import { jsonEqual, memberSchema } from './json-schema.js';
import {
  Principal,
  type PrincipalOptions,
  type ServiceRuntime,
} from './principal.js';
import { type DisposalScope, inertDisposable, toDisposable } from './scope.js';
import { PLATFORM_VERSION } from './version.js';

const HOOKS_ID = 'hooks/v1';

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** D-12: a basic contract provider must match the platform method spec. */
const assertBasicShape = (definition: AnyServiceDefinition): void => {
  const spec = basicContractSpec(definition.id);

  if (spec === undefined) {
    return;
  }

  const expected = Object.keys(spec.methods).sort();
  const actual = Object.keys(definition.methods).sort();

  if (expected.join(',') !== actual.join(',')) {
    throw new ContractError(
      'contract_mismatch',
      `Provider of "${definition.id}" must implement exactly: ${expected.join(', ')}; got: ${actual.join(', ')}.`,
      { contract: definition.id },
    );
  }

  for (const name of expected) {
    const required = spec.methods[name];
    const provided = definition.methods[name];

    if (required === undefined || provided === undefined) {
      continue;
    }

    const matches =
      jsonEqual(
        memberSchema(required.input, 'input').schema,
        memberSchema(provided.input, 'input').schema,
      ) &&
      jsonEqual(
        memberSchema(required.output, 'output').schema,
        memberSchema(provided.output, 'output').schema,
      );

    if (!matches) {
      throw new ContractError(
        'contract_mismatch',
        `Method "${name}" of "${definition.id}" does not match the platform schema.`,
        { contract: definition.id, method: name },
      );
    }
  }
};

const stubFor = <Api>(
  principal: Principal,
  target: DispatchTarget,
  checked: boolean,
): Api => {
  if (target.contractId === HOOKS_ID) {
    return createHooksFacade(
      principal,
      createStub<HooksProvider>(principal, target),
      // hooks.use(Contract) follows the same requires rule as services.use.
      checked ? (contractId) => assertUsable(principal, contractId) : undefined,
    ) as Api;
  }

  return createStub<Api>(principal, target);
};

const cardinalityOf = (principal: Principal, contractId: string) =>
  principal.runtime.catalog.cardinality(contractId) ??
  basicContractSpec(contractId)?.cardinality;

const assertUsable = (principal: Principal, contractId: string): void => {
  const { options } = principal;

  if (
    options.requires === 'any' ||
    isPlatformContract(contractId) ||
    options.requires.has(contractId) ||
    options.ownContracts?.has(contractId) === true ||
    (options.provides !== 'any' && options.provides.has(contractId)) ||
    (options.isCore === true && isBasicContract(contractId))
  ) {
    return;
  }

  throw new ContractError(
    'undeclared_requirement',
    `Bundle "${principal.bundleId}" uses "${contractId}" without listing it in requires.`,
    { contract: contractId, bundleId: principal.bundleId },
  );
};

const refId = (contract: unknown): string => {
  if (!isServiceRef(contract)) {
    throw new ContractError(
      'invalid_input',
      'Expected a contract ref created with ref().',
    );
  }

  return contract.id;
};

const provide = (
  principal: Principal,
  definition: AnyServiceDefinition,
): Disposable => {
  if (!isServiceDefinition(definition)) {
    throw new ContractError(
      'invalid_input',
      'provide expects a definition created with defineService.',
    );
  }

  const { runtime, options } = principal;
  const { id } = definition;
  const declared =
    options.provides === 'any' ? undefined : options.provides.get(id);

  if (options.provides !== 'any' && declared === undefined) {
    throw new ContractError(
      'undeclared_provide',
      `Bundle "${principal.bundleId}" provides "${id}" in ${runtime.environment} without declaring it.`,
      { contract: id, bundleId: principal.bundleId },
    );
  }

  const expected = cardinalityOf(principal, id) ?? declared?.cardinality;

  if (expected !== undefined && definition.cardinality !== expected) {
    throw new ContractError(
      'cardinality_mismatch',
      `Provider "${principal.bundleId}" declares "${id}" as ${definition.cardinality}; the catalog publishes ${expected}.`,
      { contract: id, bundleId: principal.bundleId },
    );
  }

  assertBasicShape(definition);

  if (definition.cardinality === 'one') {
    const chosen = runtime.catalog.activeProvider(id);

    if (chosen !== undefined && chosen !== principal.bundleId) {
      // The composition chose another provider here: register nothing.
      return inertDisposable;
    }
  }

  const record: ProviderRecord = Object.freeze({
    contractId: id,
    bundleId: principal.bundleId,
    version: principal.caller.version,
    contractVersion:
      declared?.version ??
      (isPlatformContract(id) ? PLATFORM_VERSION : principal.caller.version),
    environment: runtime.environment,
    cardinality: definition.cardinality,
    methods: definition.methods,
    invoke: (method: string, input: unknown, call: Call) =>
      (
        definition.methods[method] as AnyServiceDefinition['methods'][string]
      ).execute(input, call, principal.services),
  });
  const unregister = runtime.directory.register(record);
  const disposable = toDisposable(unregister);

  principal.current.track(disposable);

  return disposable;
};

const whenAvailable = (
  principal: Principal,
  checked: boolean,
  contract: AnyServiceRef,
  // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
  callback: (api: unknown, provider: ProviderInfo) => void | Cleanup,
): Disposable => {
  const contractId = refId(contract);
  const { runtime } = principal;
  const parent = principal.current;
  const children = new Map<ProviderRecord, ReturnType<typeof parent.child>>();
  const report = (error: unknown) =>
    runtime.report({
      bundleId: principal.bundleId,
      kind: 'when_available_failed',
      message: messageOf(error),
      details: { contract: contractId },
    });
  const unsubscribe = runtime.directory.subscribe(contractId, {
    added: (record) => {
      const child = parent.child();

      children.set(record, child);

      try {
        const result = principal.runInScope(child, () =>
          callback(
            stubFor(principal, { contractId, pinned: record }, checked),
            {
              bundleId: record.bundleId,
              version: record.version,
            },
          ),
        );

        if (typeof result === 'function') {
          child.onDispose(result);
        } else if (isPromiseLike(result)) {
          // An async callback: keep a cleanup it resolves to, report a rejection.
          Promise.resolve(result).then((cleanup: unknown) => {
            if (typeof cleanup === 'function') {
              child.onDispose(cleanup as Cleanup);
            }
          }, report);
        }
      } catch (error) {
        report(error);
      }
    },
    removed: (record) => {
      const child = children.get(record);

      children.delete(record);
      child?.dispose().catch(report);
    },
  });
  const disposable = toDisposable(() => {
    unsubscribe();

    for (const child of children.values()) {
      child.dispose().catch(report);
    }

    children.clear();
  });

  parent.track(disposable);

  return disposable;
};

const servicesOf = (principal: Principal, checked: boolean): Services =>
  Object.freeze({
    provide: (definition: AnyServiceDefinition) => {
      try {
        return provide(principal, definition);
      } catch (error) {
        // An undeclared provide, a divergent cardinality, a basic-contract
        // mismatch or a provider conflict: a registration failure.
        if (isContractError(error) && error.code !== 'invalid_input') {
          principal.noteRegistrationError(error);
        }

        throw error;
      }
    },
    use: (contract: AnyServiceRef, scope?: CallScope) => {
      const contractId = refId(contract);

      if (cardinalityOf(principal, contractId) === 'many') {
        throw new ContractError(
          'many_contract_use',
          `"${contractId}" has many providers; aggregate them with whenAvailable.`,
          { contract: contractId },
        );
      }

      if (checked) {
        assertUsable(principal, contractId);
      }

      return stubFor(principal, { contractId, useScope: scope }, checked);
    },
    whenAvailable: (
      contract: AnyServiceRef,
      // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
      callback: (api: unknown, provider: ProviderInfo) => void | Cleanup,
    ) => whenAvailable(principal, checked, contract, callback),
  }) as Services;

/** Creates a principal with its checked and unchecked services. */
export const createPrincipal = (
  runtime: ServiceRuntime,
  options: PrincipalOptions,
): Principal => {
  const principal = new Principal(runtime, options);

  principal.services = servicesOf(principal, true);
  principal.unchecked = servicesOf(principal, false);

  return principal;
};

/** What `createElementScope` returns: the element's services and their end. */
export interface ElementScope {
  readonly services: Services;
  /** Disposes everything registered through `services`; idempotent. */
  dispose(): Promise<void>;
}

const isThenable = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/**
 * Whether an object result carries functions a later call would run (a hooks
 * handle or registrar), as opposed to data or a plain Disposable.
 */
const carriesCalls = (value: object, depth = 2): boolean =>
  Object.entries(value).some(
    ([key, member]) =>
      (typeof member === 'function' && key !== 'dispose') ||
      (depth > 1 &&
        typeof member === 'object' &&
        member !== null &&
        carriesCalls(member, depth - 1)),
  );

/**
 * Stage 9 (D9-2): services for one element, a child scope of the owner's
 * activation scope. Every `provide`, every stub method call and every
 * `whenAvailable` made through them (also later, from a stub kept by the
 * element) runs inside that child, so its Disposables end with `dispose`
 * while the owner's own registrations survive.
 */
export const createElementScope = (principal: Principal): ElementScope => {
  const child = principal.scope.child();
  const run = <T>(scope: DisposalScope, fn: () => T): T =>
    principal.runInScope(scope, fn);

  const wrapFunction =
    (
      fn: (...args: unknown[]) => unknown,
      owner: unknown,
      scope: DisposalScope,
    ) =>
    (...args: unknown[]): unknown =>
      wrapResult(
        run(scope, () => Reflect.apply(fn, owner, args)),
        scope,
      );

  /** A view of a stub or facade whose calls run in `scope`. */
  const wrapObject = (target: object, scope: DisposalScope): object => {
    const cache = new Map<PropertyKey, unknown>();

    return new Proxy(Object.create(null) as object, {
      get: (_view, property) => {
        const member = Reflect.get(target, property) as unknown;

        if (typeof member !== 'function') {
          return typeof member === 'object' &&
            member !== null &&
            !isThenable(member) &&
            carriesCalls(member)
            ? wrapObject(member, scope)
            : member;
        }

        let wrapped = cache.get(property);

        if (wrapped === undefined) {
          wrapped = wrapFunction(
            member as (...args: unknown[]) => unknown,
            target,
            scope,
          );
          cache.set(property, wrapped);
        }

        return wrapped;
      },
      has: (_view, property) => Reflect.has(target, property),
    });
  };

  const wrapResult = (value: unknown, scope: DisposalScope): unknown =>
    typeof value === 'object' &&
    value !== null &&
    !isThenable(value) &&
    carriesCalls(value)
      ? wrapObject(value, scope)
      : value;

  const base = principal.services;
  const services = Object.freeze({
    provide: (definition: AnyServiceDefinition) =>
      run(child, () => base.provide(definition as never)),
    use: (contract: AnyServiceRef, scope?: CallScope) =>
      wrapObject(
        run(child, () => base.use(contract as never, scope)) as object,
        child,
      ),
    whenAvailable: (
      contract: AnyServiceRef,
      // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
      callback: (api: unknown, provider: ProviderInfo) => void | Cleanup,
    ) =>
      run(child, () =>
        base.whenAvailable(
          contract as never,
          ((api: unknown, provider: ProviderInfo) =>
            // whenAvailable runs the callback in a child of `child`; later
            // calls of the api stay in that child.
            callback(
              wrapObject(api as object, principal.current),
              provider,
            )) as never,
        ),
      ),
  }) as unknown as Services;

  return { services, dispose: () => child.dispose() };
};
