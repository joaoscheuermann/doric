// `doric.elements/v1` (stage 9, D9-2): the window's record of which bundle
// owns each custom element tag, and the services an element gets — a child
// scope of its owner's services, ended by `release`. Only the window's active
// `ui/v1` provider may call it.

import {
  type Call,
  type Caller,
  ContractError,
  type Disposable,
  DoricElementsV1,
  defineMethod,
  type ElementConstructor,
} from 'bundle/contracts';
import {
  createElementScope,
  type DiagnosticsStore,
  definePlatformService,
  type ElementScope,
  type Principal,
  platformContracts,
} from 'bundle/runtime';

/** The part of `customElements` the provider uses. */
export interface ElementRegistry {
  define(tag: string, element: CustomElementConstructor): void;
  get(tag: string): CustomElementConstructor | undefined;
}

interface TagRecord {
  readonly owner: Caller;
  disposed: boolean;
}

const UI_CONTRACT = 'ui/v1';

const tagOf = (element: object): string | undefined => {
  const { localName, tagName } = element as {
    readonly localName?: unknown;
    readonly tagName?: unknown;
  };

  if (typeof localName === 'string') {
    return localName;
  }

  return typeof tagName === 'string' ? tagName.toLowerCase() : undefined;
};

const defaultRegistry = (): ElementRegistry => {
  const registry = (globalThis as { customElements?: ElementRegistry })
    .customElements;

  if (registry === undefined) {
    throw new ContractError(
      'unavailable',
      'This window has no custom element registry.',
    );
  }

  return registry;
};

/** Registers `doric.elements/v1` under the window platform principal. */
export const provideElements = (
  platform: Principal,
  options: {
    /** The bundles' principals of this window, by bundle ID. */
    readonly principals: ReadonlyMap<string, Principal>;
    readonly diagnostics: DiagnosticsStore;
    /** Default `globalThis.customElements` (tests inject). */
    readonly registry?: () => ElementRegistry;
  },
): void => {
  const tags = new Map<string, TagRecord>();
  const scopes = new WeakMap<object, ElementScope>();
  const registry = options.registry ?? defaultRegistry;
  const methods = platformContracts['doric.elements/v1'].methods;
  const report = (error: unknown) =>
    platform.runtime.report({
      bundleId: platform.bundleId,
      kind: 'dispose_failed',
      message: error instanceof Error ? error.message : String(error),
    });

  const assertUi = (call: Call): void => {
    const active = platform.runtime.catalog.activeProvider(UI_CONTRACT);

    if (active === undefined || call.caller.bundleId !== active) {
      throw new ContractError(
        'not_owner',
        `Only the active ${UI_CONTRACT} provider may call doric.elements/v1; "${call.caller.bundleId}" is not it.`,
        { contract: 'doric.elements/v1', bundleId: call.caller.bundleId },
      );
    }
  };

  const activeOwner = (tag: string): Caller | undefined => {
    const record = tags.get(tag);

    if (record === undefined || record.disposed) {
      return undefined;
    }

    const principal = options.principals.get(record.owner.bundleId);

    if (
      principal === undefined ||
      principal.closed ||
      principal.scope.disposed ||
      options.diagnostics.state(record.owner.bundleId) === 'quarantined'
    ) {
      return undefined;
    }

    return record.owner;
  };

  platform.services.provide(
    definePlatformService(DoricElementsV1, {
      define: defineMethod({
        input: methods.define.input,
        output: methods.define.output,
        execute: (
          input: {
            readonly tag: string;
            readonly element: ElementConstructor;
            readonly owner: Caller;
          },
          call,
        ): Disposable => {
          assertUi(call);

          const previous = tags.get(input.tag);

          if (
            previous !== undefined ||
            registry().get(input.tag) !== undefined
          ) {
            throw new ContractError(
              'registration_conflict',
              previous === undefined || previous.disposed
                ? `<${input.tag}> is already defined in this window.`
                : `<${input.tag}> is already defined by bundle "${previous.owner.bundleId}".`,
              { tag: input.tag },
            );
          }

          registry().define(
            input.tag,
            input.element as unknown as CustomElementConstructor,
          );

          const record: TagRecord = {
            owner: Object.freeze({ ...input.owner }),
            disposed: false,
          };

          tags.set(input.tag, record);

          return {
            dispose: () => {
              // A custom element cannot be undefined: the tag stays taken and
              // has no owner from now on.
              record.disposed = true;
            },
          };
        },
      }),
      owner: defineMethod({
        input: methods.owner.input,
        output: methods.owner.output,
        execute: (tag: string, call) => {
          assertUi(call);

          return activeOwner(tag);
        },
      }),
      attach: defineMethod({
        input: methods.attach.input,
        output: methods.attach.output,
        execute: (element: object, call) => {
          assertUi(call);

          if (scopes.has(element)) {
            return;
          }

          const tag = tagOf(element);
          const owner = tag === undefined ? undefined : activeOwner(tag);
          const principal =
            owner === undefined
              ? undefined
              : options.principals.get(owner.bundleId);

          if (principal === undefined) {
            throw new ContractError(
              'unavailable',
              `<${tag ?? '?'}> has no active owner in this window.`,
              { tag },
            );
          }

          const scope = createElementScope(principal);

          scopes.set(element, scope);
          (element as { services?: unknown }).services = scope.services;
        },
      }),
      release: defineMethod({
        input: methods.release.input,
        output: methods.release.output,
        execute: (element: object, call) => {
          assertUi(call);

          const scope = scopes.get(element);

          if (scope === undefined) {
            return;
          }

          scopes.delete(element);
          scope.dispose().catch(report);
        },
      }),
    }),
  );
};
