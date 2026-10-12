// The core's client ui/v1 (stage 9, §4.3): custom element tags owned by the
// bundle that defines them, elements created with a child scope of their
// owner's services (`doric.elements/v1`), and disposal that ends that scope.

import {
  type Call,
  ContractError,
  DoricElementsV1,
  defineMethod,
  defineService,
  type ElementConstructor,
  type Services,
  UiV1,
  uiMethods,
} from 'bundle/contracts';

/** The tag `create` returns when no active bundle owns the requested one. */
export const UNAVAILABLE_TAG = 'core-unavailable';

interface Disposing {
  remove?: () => void;
  dispose?: () => void;
}

export const createUi = () => {
  const disposed = new WeakSet<object>();

  // By ID: the typed form cannot express ui/v1's one-object dispose.
  return defineService(UiV1.id, {
    define: defineMethod({
      input: uiMethods.define.input,
      output: uiMethods.define.output,
      execute: (
        [tag, element]: [string, ElementConstructor],
        call: Call,
        services: Services,
      ) => {
        const owner = call.caller.bundleId;

        if (!tag.startsWith(`${owner}-`)) {
          throw new ContractError(
            'invalid_input',
            `The tag "${tag}" must start with "${owner}-".`,
            { tag },
          );
        }

        return services
          .use(DoricElementsV1)
          .define({ tag, element, owner: call.caller }, call);
      },
    }),
    create: defineMethod({
      input: uiMethods.create.input,
      output: uiMethods.create.output,
      execute: (
        [tag, props]: [string, Readonly<Record<string, unknown>>?],
        call: Call,
        services: Services,
      ) => {
        const elements = services.use(DoricElementsV1);

        if (elements.owner(tag, call) === undefined) {
          const placeholder = document.createElement(UNAVAILABLE_TAG);

          placeholder.setAttribute('data-tag', tag);

          return placeholder;
        }

        const element = document.createElement(tag);

        elements.attach(element, call);
        Object.assign(element, props ?? {});

        return element;
      },
    }),
    dispose: defineMethod({
      input: uiMethods.dispose.input,
      output: uiMethods.dispose.output,
      execute: (element: object, call: Call, services: Services) => {
        if (disposed.has(element)) {
          return;
        }

        disposed.add(element);

        const target = element as Disposing;

        try {
          target.remove?.();
          target.dispose?.();
        } finally {
          services.use(DoricElementsV1).release(element, call);
        }
      },
    }),
  });
};
