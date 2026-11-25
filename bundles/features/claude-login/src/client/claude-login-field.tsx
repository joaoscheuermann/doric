// `claude-login-field`, the item of `settings.provider.field` that stands in
// for the `claude` kind's `token` field (bundle isolation 6(a)): the Claude
// sign-in row. The settings page sets `view`; a finished sign-in answers it
// with the bubbling, composed DOM event `settings-provider-field`, carrying the
// stored credential's id, which the page writes into the field.

import type { ClientServices, Services } from 'bundle/contracts';
import { Button } from 'desktop/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from 'desktop/ui/field';
import {
  defineReactElement,
  type ReactElementInstance,
} from 'desktop/ui/react-element';
import { LogInIcon } from 'lucide-react';
import { useMemo, useRef } from 'react';
import type { ProviderFieldView } from 'settings/contracts';

import { createClaudeLoginApi } from './api.js';
import { useClaudeLogin } from './use-claude-login.js';

export const CLAUDE_LOGIN_FIELD_TAG = 'claude-login-field';

export interface ClaudeLoginFieldProps {
  readonly view?: ProviderFieldView;
}

/** What the row says in place of the page's issue, by the view's problem. */
const problemMessages = {
  missing: 'Sign in with Claude to finish this provider.',
  unknown:
    'The credential this provider names is no longer stored: sign in with Claude again.',
} as const;

/** The sign-in row for one `view`, over the owner's services. */
function ClaudeLoginField({
  view,
  services,
}: ClaudeLoginFieldProps & { readonly services: Services }) {
  const root = useRef<HTMLDivElement>(null);
  const api = useMemo(
    () => createClaudeLoginApi(services as ClientServices),
    [services],
  );
  const login = useClaudeLogin(api, (credential) => {
    root.current?.dispatchEvent(
      new CustomEvent('settings-provider-field', {
        bubbles: true,
        composed: true,
        detail: { value: credential.id },
      }),
    );
  });

  if (view === undefined) return null;
  const signedIn = view.label;

  return (
    <div ref={root} className="contents">
      <Field>
        <FieldLabel>Claude login</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={login.busy}
            onClick={() => login.start()}
          >
            <LogInIcon data-icon="inline-start" />
            {login.busy
              ? 'Waiting for the browser…'
              : signedIn === undefined
                ? 'Sign in with Claude'
                : 'Sign in again'}
          </Button>
          {login.busy && (
            <Button variant="ghost" size="sm" onClick={() => login.cancel()}>
              Cancel
            </Button>
          )}
        </div>
        <FieldDescription>
          {signedIn === undefined
            ? 'Signs in with a Claude Code subscription: the browser opens, and the login is stored as a credential this provider uses.'
            : `Signed in: this provider uses the '${signedIn}' credential. When Claude requests fail with an authentication error, the login expired or was revoked: sign in again.`}
        </FieldDescription>
        {login.busy && login.url !== undefined && (
          <FieldDescription>
            If the browser did not open, visit{' '}
            <span className="break-all select-all">{login.url}</span>
          </FieldDescription>
        )}
        {view.problem !== undefined && (
          <FieldError>{problemMessages[view.problem]}</FieldError>
        )}
      </Field>
    </div>
  );
}

/** The element class of `claude-login-field`; draws nothing until `view` is set. */
export const defineClaudeLoginField = (): (new () => ReactElementInstance) =>
  defineReactElement<ClaudeLoginFieldProps>({
    props: ['view'],
    render: ClaudeLoginField,
  });
