// The claude-login bundle's client part (bundle isolation 6(a)): the Claude
// sign-in of the settings window's provider page. It defines
// `claude-login-field` and adds it to `settings.provider.field` in place of
// the `claude` kind's `token` field; `settings` draws it and writes the
// credential it answers into the field.

import { type ClientContext, RegionsV1, UiV1 } from 'bundle/contracts';
import type {
  ProviderFieldItemProps,
  SETTINGS_PROVIDER_FIELD,
} from 'settings/contracts';

import {
  CLAUDE_LOGIN_FIELD_TAG,
  defineClaudeLoginField,
} from './claude-login-field.js';

export function activate({ services }: ClientContext): () => void {
  const ui = services.use(UiV1);
  const regions = services.use(RegionsV1);
  const registrations = [
    ui.define(CLAUDE_LOGIN_FIELD_TAG, defineClaudeLoginField()),
    regions.add(
      'settings.provider.field' satisfies typeof SETTINGS_PROVIDER_FIELD,
      {
        id: 'claude-login',
        tag: CLAUDE_LOGIN_FIELD_TAG,
        props: {
          kind: 'claude',
          field: 'token',
        } satisfies ProviderFieldItemProps,
      },
    ),
  ];

  return () => {
    for (const registration of registrations.reverse()) registration.dispose();
  };
}
