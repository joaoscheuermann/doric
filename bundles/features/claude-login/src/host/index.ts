import type { HostContext } from 'bundle/contracts';

import { type ClaudeLoginDeps, loginService } from './login.js';

/** The host part's options: the dependency seams, for tests that inject fakes. */
export interface LoginBundleOptions {
  /** How the host resolves, opens and exchanges a Claude login; the real OAuth pieces by default. */
  readonly deps?: ClaudeLoginDeps;
}

/** The host part with its seams, so tests can activate with injected fakes. */
export const createActivate =
  (options: LoginBundleOptions = {}) =>
  ({ services }: HostContext): void => {
    services.provide(loginService(options.deps));
  };

/** Provides `claude.login/v1`, the in-app Claude sign-in. */
export const activate = createActivate();
