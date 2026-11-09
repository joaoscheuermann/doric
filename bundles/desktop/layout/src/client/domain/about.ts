// The app's version for the account menu (S26, S35). `doric.about/v1` is a
// platform contract of 1.2.0: an older app has no provider and its
// `bundle/contracts` does not export `DoricAboutV1`, so the ref is declared
// here with `ref` and the interface is imported as a type only. The layout
// follows the contract with `whenAvailable` and shows no version without it.

import type { Disposable, DoricAbout, Services } from 'bundle/contracts';
import { ref } from 'bundle/contracts';
import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';

/**
 * `doric.about/v1`, built from its id so the layout loads on an app before
 * 1.2.0 (S35). Never in the manifest's `requires`; never `use`d without a
 * provider. Detect it with `services.whenAvailable(AboutV1, …)`.
 */
export const AboutV1 = ref<DoricAbout>('doric.about/v1');

const aboutStore = createStore<{ readonly version?: string }>()(() => ({}));

const version = (): string | undefined => aboutStore.getState().version;

/**
 * Sets the app version the account menu shows. `undefined` hides it, and the
 * footer reads "MIT License" alone. Setting the current value notifies no one.
 */
export const setAboutVersion = (next: string | undefined): void => {
  aboutStore.setState((state) =>
    state.version === next ? state : { version: next },
  );
};

/**
 * The app version for React. It is `undefined` before `doric.about/v1`
 * answers, on an app without the contract, after the answer fails, and after
 * `followAbout`'s disposable is disposed. Re-renders only when the value
 * changes.
 */
export const useAboutVersion = (): string | undefined =>
  useSyncExternalStore(aboutStore.subscribe, version, version);

/**
 * Follows `doric.about/v1` through `services.whenAvailable(AboutV1, …)`.
 * - While a provider exists, its `get()` answer becomes the version.
 * - If `get()` rejects, the version stays `undefined`, and nothing is logged
 *   as an error.
 * - When the provider goes, the version is cleared.
 * - Never throws, also on an app without the contract, where it never sets a
 *   version.
 * - Disposing stops following and clears the version. An answer that
 *   resolves after its provider's cleanup or after `dispose` is dropped.
 */
export const followAbout = (services: Services): Disposable => {
  // `current` drops a late answer after this provider's cleanup; `disposed`
  // also drops it when a host's disposal skips that cleanup.
  let disposed = false;
  const following = services.whenAvailable(AboutV1, (about) => {
    let current = true;
    void about.get().then(
      (answer) => {
        if (current && !disposed) setAboutVersion(answer.version);
      },
      () => {
        if (current && !disposed) setAboutVersion(undefined);
      },
    );
    return () => {
      current = false;
      setAboutVersion(undefined);
    };
  });
  return {
    dispose: () => {
      disposed = true;
      following.dispose();
      setAboutVersion(undefined);
    },
  };
};
