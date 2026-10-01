import { SettingsCredentials } from '@/components/organisms/settings-credentials';
import { SettingsExecution } from '@/components/organisms/settings-execution';
import { SettingsProviderScreen } from '@/components/organisms/settings-provider';
import { SettingsProviders } from '@/components/organisms/settings-providers';
import { SettingsVersioning } from '@/components/organisms/settings-versioning';
import type {
  SettingsCrumb,
  SettingsNavItem,
} from '@/components/templates/settings-surface';
import { SettingsWindow } from '@/components/templates/settings-window';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  applyProviderDraft,
  type Configuration,
  emptyProviderDraft,
  kindOf,
  type ProviderDraft,
  providerDraftOf,
  type ProviderKind,
  providerLabel,
  updatedAtLabel,
} from '@/domain/config';
import { filterSettingsSections } from '@/domain/settings-search';
import { type Config, useConfig } from '@/hooks/use-config';
import { type Credentials, useCredentials } from '@/hooks/use-credentials';
import { useProviderKinds } from '@/hooks/use-provider-kinds';
import {
  AlertCircleIcon,
  GitBranchIcon,
  KeyRoundIcon,
  ServerIcon,
  ZapIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * The sections this window offers, in the order the nav lists them. Each one
 * carries the label its heading shows and the sentence the nav searches beside
 * it, so a reader finds a section by what it explains — "turns", "push" — not
 * only by the one word it is named after.
 */
const sections = [
  {
    icon: ServerIcon,
    id: 'providers',
    label: 'Providers',
    description:
      'Every provider Doric may call, and the credential each one authenticates with.',
  },
  {
    icon: ZapIcon,
    id: 'execution',
    label: 'Execution',
    description:
      'What runs a prompt: the provider, the model on it, its reasoning effort, and how many turns one prompt may take.',
  },
  {
    icon: GitBranchIcon,
    id: 'versioning',
    label: 'Versioning',
    description:
      'Which stored credentials the agent commits and pushes with inside a Project.',
  },
  {
    icon: KeyRoundIcon,
    id: 'credentials',
    label: 'Credentials',
    description:
      'Secrets the host stores and never sends back. A provider and the Git integrations each choose the credential they use, so a key is entered once here and named everywhere it applies.',
  },
] as const satisfies readonly (SettingsNavItem & {
  readonly description: string;
})[];

type SectionId = (typeof sections)[number]['id'];

/** The shape of a section while the host's configuration is still arriving. */
function SectionSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-48" />
    </div>
  );
}

/**
 * What the footer says about the save: the host's message when a save failed,
 * a save in flight or waiting on the debounce, or the settled state. A draft
 * the host would refuse is never sent, so it has no save state of its own — the
 * section shows the issue instead.
 */
function saveState(
  config: Config,
): { readonly destructive: boolean; readonly text: string } | undefined {
  if (config.error !== undefined) {
    return { destructive: true, text: config.error };
  }
  if (config.saving || (config.dirty && config.issue === undefined)) {
    return { destructive: false, text: 'Saving…' };
  }
  if (config.saved !== undefined && !config.dirty) {
    return { destructive: false, text: 'Saved' };
  }
  return undefined;
}

/**
 * The active section's own surface. The nav and this switch name the same ids,
 * so a section is one nav entry and one case here. The providers section opens
 * its own page for a provider through the callbacks, which the view owns because
 * the page sits above this content in the window's chrome.
 */
function Section({
  credentials,
  draft,
  id,
  kinds,
  onAdd,
  onChange,
  onEdit,
}: {
  readonly credentials: Credentials;
  readonly draft: Configuration;
  readonly id: SectionId;
  readonly kinds: readonly ProviderKind[];
  readonly onAdd: () => void;
  readonly onChange: (next: Configuration) => void;
  readonly onEdit: (index: number) => void;
}) {
  switch (id) {
    case 'providers':
      return (
        <SettingsProviders
          credentials={credentials.list}
          draft={draft}
          kinds={kinds}
          onAdd={onAdd}
          onChange={onChange}
          onEdit={onEdit}
        />
      );
    case 'execution':
      return <SettingsExecution draft={draft} onChange={onChange} />;
    case 'versioning':
      return (
        <SettingsVersioning
          credentials={credentials.list}
          draft={draft}
          onChange={onChange}
        />
      );
    case 'credentials':
      return <SettingsCredentials />;
  }
}

/**
 * The standalone settings window. The configuration is one value the host owns,
 * so the window shows only what the host stores, whether or not any Project or
 * Thread is open. There is no Save button: a valid change sends itself after a
 * short pause, on a field blur, and as the window closes, and the footer reports
 * the save instead of offering one.
 *
 * A section shows its own list; a provider opens one page deeper, under the
 * providers section, which the window's bar names and leads back from. The page
 * owns no save of its own either: it writes each accepted change into the same
 * configuration, and the section's debounce carries it like every other control.
 */
export function Settings() {
  const credentials = useCredentials();
  const kinds = useProviderKinds();
  const config = useConfig(true, kinds.list);
  const [section, setSection] = useState<SectionId>('providers');
  // The query narrows the nav alone: a section it hides is still the one on
  // screen, and the nav then shows no active row for as long as the query lasts.
  const [query, setQuery] = useState('');
  // The provider whose page is open under the providers section, or `undefined`
  // while that section shows its list. It carries the draft being configured, so
  // the page and the list cannot disagree about which provider is open.
  const [provider, setProvider] = useState<ProviderDraft>();
  const current = sections.find((item) => item.id === section) ?? sections[0];
  // The one icon the section is named by, drawn by the nav, the section heading
  // and the provider page alike, so they never drift.
  const Icon = current.icon;
  const { draft, flush } = config;
  // What the heading names: the section's own while its list shows, and the
  // provider page's while one is open. The breadcrumb carries the provider's own
  // name, so the heading says which page this is rather than repeating it.
  const title =
    provider === undefined
      ? current.label
      : provider.index === undefined
        ? 'Add provider'
        : 'Edit provider';
  // The chain the window's bar draws, outermost first. The section is a control
  // while a provider page sits under it, and the page itself is the last part,
  // which is where the chain already is.
  const trail: readonly SettingsCrumb[] = [
    { label: 'Settings' },
    provider === undefined
      ? { label: current.label }
      : { label: current.label, onSelect: () => setProvider(undefined) },
    ...(provider === undefined
      ? []
      : [
          {
            label:
              provider.index === undefined
                ? 'Add provider'
                : providerLabel(provider, provider.index),
          },
        ]),
  ];
  const status = saveState(config);
  // The revision already accounted for, so a render never repeats a message. The
  // load sets the same `saved` a write does, and the load is not a save, so the
  // first revision the hook hands over is recorded before anything is announced.
  const announced = useRef<number | undefined>(undefined);
  const loaded = useRef(false);
  if (!loaded.current && config.saved !== undefined) {
    loaded.current = true;
    announced.current = config.saved.revision;
  }

  // Closing the window is what settles a change still waiting on the debounce,
  // so the main process holds the close back and waits for this answer; a
  // `beforeunload` listener would race the teardown instead. The subscription
  // is bound once, because the hook's `flush` reads the live draft.
  useEffect(() => {
    return window.doric.settings.onFlush(() => flush());
  }, [flush]);

  // A save the host refused is announced where the change was made, not only in
  // the footer: the reason names a field the user is looking at. The error is the
  // toast's id, so the same refusal replaces its own message instead of stacking
  // on every attempt the debounce makes.
  useEffect(() => {
    if (config.error !== undefined) {
      toast.error(config.error, { id: 'config-save' });
    }
  }, [config.error]);

  // A save the host accepted is confirmed the same way. This surface has no Save
  // button — a change sends itself once typing settles — so the confirmation is
  // the only thing that says the host took it, and it is keyed on the revision so
  // one accepted save is announced exactly once, however many renders follow.
  useEffect(() => {
    const revision = config.saved?.revision;
    if (revision === undefined || announced.current === revision) return;
    announced.current = revision;
    toast.success('Settings saved.', { id: 'config-save' });
  }, [config.saved]);

  const selectSection = (id: string): void => {
    const match = sections.find((item) => item.id === id);
    if (match !== undefined) {
      setSection(match.id);
      // A section is where the chain starts over, so a provider page opened under
      // the previous one does not stay half-open behind the new section.
      setProvider(undefined);
    }
  };

  /**
   * Opens the providers section's page for the provider at one list position.
   * The position is how a row addresses its provider, and the same one the page
   * edits, so the order the table draws rows in never decides which is opened.
   */
  const editProvider = (index: number): void => {
    if (draft === undefined) return;
    const next = providerDraftOf(draft, index);
    if (next !== undefined) setProvider(next);
  };

  /** Opens the same page for a provider that does not exist yet. */
  const addProviderPage = (): void => {
    const first = kinds.list[0];
    if (first !== undefined) setProvider(emptyProviderDraft(first));
  };

  /**
   * Writes the provider page's draft into the configuration as soon as it is one
   * the host would accept, so the window's own save carries it and leaving the
   * page needs no commit of its own. A draft that is not yet valid stays local:
   * a half-typed id or a missing field never reaches the list, nor does it stop
   * the rest of the window from saving.
   */
  const changeProvider = (next: ProviderDraft): void => {
    const kind = kindOf(kinds.list, next.kind);
    if (draft === undefined || kind === undefined) {
      setProvider(next);
      return;
    }
    const applied = applyProviderDraft(draft, next, kind, credentials.list);
    if (applied === undefined) {
      setProvider(next);
      return;
    }
    setProvider(applied.draft);
    config.setDraft(applied.configuration);
  };

  // The nav's footer states the save state alone: the revision line beside it
  // is wider than the nav column, so it stays in the content footer. Neither
  // footer offers a control, so no action is offered twice.
  const navSaveState =
    status === undefined ? undefined : (
      <span
        className={
          status.destructive
            ? 'truncate text-xs text-destructive'
            : 'truncate text-xs text-muted-foreground'
        }
      >
        {status.text}
      </span>
    );

  return (
    <SettingsWindow
      activeId={current.id}
      trail={trail}
      onBack={provider === undefined ? undefined : () => setProvider(undefined)}
      nav={filterSettingsSections(sections, query)}
      onQueryChange={setQuery}
      onSelect={selectSection}
      query={query}
      sidebarFooter={navSaveState}
      footer={
        <div className="flex w-full items-center gap-2 text-xs text-muted-foreground">
          {config.saved !== undefined && (
            <span>
              Revision {config.saved.revision} · Updated{' '}
              {updatedAtLabel(config.saved.updatedAt)}
            </span>
          )}
          {status !== undefined && (
            <>
              {config.saved !== undefined && <span>·</span>}
              <span className={status.destructive ? 'text-destructive' : ''}>
                {status.text}
              </span>
            </>
          )}
        </div>
      }
    >
      {/* A blur on any field sends the change waiting on the debounce. */}
      <div onBlur={() => void flush()}>
        {/*
          The section's own icon leads its heading, the same one the nav draws
          beside the label, so the two name one section rather than two that
          happen to share a word. The heading is an `<h1>` because the window
          holds one section at a time, so the section is the page of this
          surface. The heading names the page and stops there: what the page is
          for is the controls themselves, not a sentence about them.
        */}
        <header className="mb-4 flex items-center gap-2">
          <Icon aria-hidden className="size-5 shrink-0" />
          <h1 className="text-lg font-medium">{title}</h1>
        </header>
        {config.issue !== undefined && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircleIcon />
            <AlertTitle>This change cannot be saved yet</AlertTitle>
            <AlertDescription>{config.issue}</AlertDescription>
          </Alert>
        )}
        {draft === undefined ? (
          config.loading && <SectionSkeleton />
        ) : current.id === 'providers' && provider !== undefined ? (
          <SettingsProviderScreen
            credentials={credentials.list}
            draft={provider}
            kinds={kinds.list}
            onChange={changeProvider}
          />
        ) : (
          <Section
            credentials={credentials}
            draft={draft}
            id={current.id}
            kinds={kinds.list}
            onAdd={addProviderPage}
            onChange={config.setDraft}
            onEdit={editProvider}
          />
        )}
      </div>
    </SettingsWindow>
  );
}

export default Settings;
