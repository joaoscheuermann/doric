// A window's `Services` for stories: each contract the story serves is a
// fake API keyed by its contract id, reached through `whenAvailable` and
// `use` exactly as the git elements reach them. Nothing here talks to a
// host; every API is a plain object of fixture answers.

import type { Disposable, Services } from 'bundle/contracts';

const provider = { bundleId: 'stories', version: '1.0.0' };

const done: Disposable = { dispose: () => undefined };

/** Services that serve `apis` by contract id and nothing else. */
export const fakeServices = (
  apis: Readonly<Record<string, unknown>>,
): Services => {
  const lookup = (contract: { readonly id: string }) =>
    Object.hasOwn(apis, contract.id) ? apis[contract.id] : undefined;
  const services = {
    provide: () => done,
    use: (contract: { readonly id: string }) => {
      const api = lookup(contract);
      if (api === undefined)
        throw new Error(`${contract.id} is not served in this story.`);
      return api;
    },
    whenAvailable: (
      contract: { readonly id: string },
      callback: (api: unknown, info: typeof provider) => unknown,
    ): Disposable => {
      const api = lookup(contract);
      if (api === undefined) return done;
      const cleanup = callback(api, provider);
      let active = true;
      return {
        dispose: () => {
          if (!active) return;
          active = false;
          if (typeof cleanup === 'function') void cleanup();
        },
      };
    },
  };
  return services as unknown as Services;
};

/** A `subscribe(listener)` that never notifies: the fixture never changes. */
export const still = (): Disposable => done;
