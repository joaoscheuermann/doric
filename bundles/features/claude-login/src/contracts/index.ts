// Public contract of the `claude-login` bundle: the in-app Claude Code sign-in
// behind the settings window's provider page. `login()` answers the stored
// `API_TOKEN` credential's public view — never the authorization value — so the
// provider screen can reuse an existing Claude Code login or open a fresh one
// in the browser, and then name the answered credential as the `claude` kind's
// `token` field.

import {
  type CallArg,
  type CredentialDescription,
  credentialDescriptionSchema,
  type MethodSpecs,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

export type { CredentialDescription };

/** `claude.login/v1` (host): sign in with a Claude Code subscription. */
export interface ClaudeLogin {
  /**
   * Signs in to Claude: an existing Claude Code login is reused when one is
   * present, otherwise the browser opens a fresh authorization. Answers the
   * stored credential's public view; `claude_login_busy` while one is already
   * running, `claude_login_aborted` when the caller cancels.
   */
  login(call?: CallArg): Promise<CredentialDescription>;
}

/** The wire shapes of `claude.login/v1`: no input, the credential view out. */
export const claudeLoginMethods = {
  login: { input: z.tuple([]), output: credentialDescriptionSchema },
} as const satisfies MethodSpecs;

/** `claude.login/v1`, provided by the `claude-login` bundle. */
export const ClaudeLoginV1 = ref<ClaudeLogin>('claude.login/v1');
