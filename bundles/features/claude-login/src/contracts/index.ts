// Public contract of the `claude-login` bundle: the in-app Claude Code sign-in
// behind the settings window's provider page. The host prepares the browser
// authorization and answers its URL; the window opens that URL in the system
// browser (`doric.browser/v1`), because the host may run where no browser
// does, and then waits on `finish()` for the host to receive the callback.
// `finish()` answers the stored `API_TOKEN` credential's public view — never
// the authorization value — so the provider screen can name it as the
// `claude` kind's `token` field.

import {
  type CallArg,
  type CredentialDescription,
  credentialDescriptionSchema,
  type MethodSpecs,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

export type { CredentialDescription };

/** A started sign-in: the authorization page the browser opens. */
export interface ClaudeLoginStart {
  /** The `https:` authorization URL; it carries the sign-in's state. */
  readonly url: string;
}

/** `claude.login/v1` (host): sign in with a Claude Code subscription. */
export interface ClaudeLogin {
  /**
   * Prepares a fresh browser sign-in: binds the loopback callback and
   * answers the authorization URL to open. A sign-in already waiting is
   * cancelled and replaced; one nobody finishes ends on its own after a
   * deadline.
   */
  start(call?: CallArg): Promise<ClaudeLoginStart>;
  /**
   * Waits for the browser to answer the started sign-in, stores its
   * authorization and answers the stored credential's public view.
   * `claude_login_not_started` with no sign-in waiting,
   * `claude_login_busy` while another `finish()` waits on it,
   * `claude_login_aborted` when the caller cancels (or a newer `start()`
   * replaced it), `claude_login_failed` when the authorization failed.
   */
  finish(call?: CallArg): Promise<CredentialDescription>;
}

/** The wire shapes of `claude.login/v1`. */
export const claudeLoginMethods = {
  start: {
    input: z.tuple([]),
    output: z.object({ url: z.string() }).strict(),
  },
  finish: { input: z.tuple([]), output: credentialDescriptionSchema },
} as const satisfies MethodSpecs;

/** `claude.login/v1`, provided by the `claude-login` bundle. */
export const ClaudeLoginV1 = ref<ClaudeLogin>('claude.login/v1');
