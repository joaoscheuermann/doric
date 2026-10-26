import type { Cleanup, HostContext } from 'bundle/contracts';

import { type ClaudeLoginDeps, loginService } from './login.js';

/** The host part's options: the dependency seams, for tests that inject fakes. */
export interface LoginBundleOptions {
  /** How the host binds, opens and exchanges a Claude sign-in; the real OAuth pieces by default. */
  readonly deps?: ClaudeLoginDeps;
}

/** The host part with its seams, so tests can activate with injected fakes. */
export const createActivate =
  (options: LoginBundleOptions = {}) =>
  ({ services }: HostContext): Cleanup => {
    const { service, cleanup } = loginService(options.deps);
    services.provide(service);
    // A sign-in still waiting when the bundle stops closes its callback server.
    return cleanup;
  };

/** Provides `claude.login/v1`, the in-app Claude sign-in. */
export const activate = createActivate();
