import { Button } from 'desktop/ui/button';
import { toast } from 'desktop/ui/sonner';
import { ExternalLinkIcon } from 'lucide-react';

import { api } from '../../api/settings-api.js';
import {
  type Credential,
  type ProviderDraft,
  type ProviderKind,
  providerLabel,
} from '../../domain/config.js';
import { messageFrom } from '../../domain/errors.js';
import { providerSite } from '../../domain/provider-icon.js';
import type { ClaudeLogin } from '../../hooks/use-claude-login.js';
import { ProviderIcon } from '../molecules/provider-icon.js';
import { SettingsProviderScreen } from './settings-provider.js';

/**
 * A provider's page in the dashboard's main area: a title bar with the
 * provider's mark and name ("Add provider" for one not yet saved) and, for a
 * kind with a site of its own, a control that opens it in the system browser;
 * then the same provider form the settings window draws. A blur on any field
 * sends the change waiting on the debounce.
 */
export function DashboardProviderPage({
  claudeLogin,
  credentials,
  draft,
  kinds,
  onChange,
  onFlush,
}: {
  /** The Claude sign-in the `claude` kind's row offers, while a provider answers it. */
  readonly claudeLogin?: ClaudeLogin;
  readonly credentials: readonly Credential[];
  readonly draft: ProviderDraft;
  readonly kinds: readonly ProviderKind[];
  readonly onChange: (next: ProviderDraft) => void;
  readonly onFlush: () => void;
}) {
  const site = providerSite(draft.kind);
  const openSite = (url: string): void => {
    void api()
      .openBrowser(url)
      .catch((error: unknown) => {
        toast.error(messageFrom(error));
      });
  };

  return (
    <>
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-6">
        <ProviderIcon
          kind={draft.kind}
          endpoint={draft.configuration.endpoint}
          className="size-4 shrink-0"
        />
        <h1 className="min-w-0 flex-1 truncate text-base font-medium">
          {draft.index === undefined
            ? 'Add provider'
            : providerLabel(draft, draft.index)}
        </h1>
        {site !== undefined && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={site.label}
            title={site.label}
            onClick={() => openSite(site.url)}
          >
            <ExternalLinkIcon />
          </Button>
        )}
      </header>
      <div
        role="none"
        className="mx-auto w-full max-w-3xl p-6"
        onBlur={onFlush}
      >
        <SettingsProviderScreen
          {...(claudeLogin === undefined ? {} : { claudeLogin })}
          credentials={credentials}
          draft={draft}
          kinds={kinds}
          onChange={onChange}
        />
      </div>
    </>
  );
}
