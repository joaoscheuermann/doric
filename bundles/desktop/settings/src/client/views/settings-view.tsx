import {
  HooksV1,
  NavigationV1,
  type Services,
  WindowHooksV1,
} from 'bundle/contracts';
import { Alert, AlertDescription, AlertTitle } from 'desktop/ui/alert';
import { SidebarMenuButton, SidebarMenuItem } from 'desktop/ui/sidebar';
import { Skeleton } from 'desktop/ui/skeleton';
import { toast } from 'desktop/ui/sonner';
import { AlertCircleIcon } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { sectionIcon } from '../components/molecules/section-icon.js';
import { SettingsCredentials } from '../components/organisms/settings-credentials.js';
import { SettingsExecution } from '../components/organisms/settings-execution.js';
import { SettingsProviderScreen } from '../components/organisms/settings-provider.js';
import { SettingsProviders } from '../components/organisms/settings-providers.js';
import { SettingsTools } from '../components/organisms/settings-tools.js';
import type { SettingsCrumb } from '../components/templates/settings-surface.js';
import { SettingsWindow } from '../components/templates/settings-window.js';
import {
  applyProviderDraft,
  type Configuration,
  emptyProviderDraft,
  kindOf,
  type ProviderDraft,
  type ProviderKind,
  providerDraftOf,
  providerLabel,
  updatedAtLabel,
} from '../domain/config.js';
import { sectionIdOf } from '../domain/section-route.js';
import { sections } from '../domain/sections.js';
import { filterSettingsSections } from '../domain/settings-search.js';
import { linkHosts, type SectionId, sectionHosts } from '../elements.js';
import {
  useClaudeLogin,
  useClaudeLoginAvailable,
} from '../hooks/use-claude-login.js';
import { type Config, useConfig } from '../hooks/use-config.js';
import { type Credentials, useCredentials } from '../hooks/use-credentials.js';
import { useProviderKinds } from '../hooks/use-provider-kinds.js';
import { configBridge } from '../services/settings-config.js';

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
    case 'tools':
      return <SettingsTools draft={draft} onChange={onChange} />;
    case 'credentials':
      return <SettingsCredentials />;
  }
}

/** The window's route, read through `navigation/v1`. */
const useRoute = (services: Services) => {
  const navigation = services.use(NavigationV1);
  const subscribe = (listener: () => void) => {
    const subscription = navigation.subscribe(listener);
    return () => subscription.dispose();
  };
  return useSyncExternalStore(subscribe, () => navigation.current());
};

/** The connected host of one section element, if its route is showing. */
const useSectionHost = (id: SectionId | undefined): HTMLElement | undefined => {
  const providers = sectionHosts.providers.useHosts();
  const execution = sectionHosts.execution.useHosts();
  const tools = sectionHosts.tools.useHosts();
  const credentials = sectionHosts.credentials.useHosts();
  const hosts = { providers, execution, tools, credentials };
  return id === undefined ? undefined : hosts[id].at(-1)?.element;
};

const isSectionId = (value: string | undefined): value is SectionId =>
  sections.some((section) => section.id === value);

/**
 * The standalone settings window. The configuration is one value the host owns,
 * so the window shows only what the host stores, whether or not any Project or
 * Thread is open. There is no Save button: a valid change sends itself after a
 * short pause, on a field blur, and as the window closes, and the footer reports
 * the save instead of offering one.
 *
 * Each section is a child route of `/settings` (`/settings/<id>`), and the nav
 * lists the `settings.sections` region: this root draws every row into its
 * `settings-link` host and the active section into the element its
 * `<core-outlet>` holds. A provider opens one page deeper, under the providers
 * section, which the window's bar names and leads back from. The page owns no
 * save of its own either: it writes each accepted change into the same
 * configuration, and the section's debounce carries it like every other control.
 */
export function Settings({ services }: { readonly services: Services }) {
  const credentials = useCredentials();
  const claudeLogin = useClaudeLogin();
  const claudeLoginAvailable = useClaudeLoginAvailable();
  const kinds = useProviderKinds();
  const config = useConfig(true, kinds.list);
  const route = useRoute(services);
  // The query narrows the nav alone: a section it hides is still the one on
  // screen, and the nav then shows no active row for as long as the query lasts.
  const [query, setQuery] = useState('');
  // The provider whose page is open under the providers section, or `undefined`
  // while that section shows its list. It carries the draft being configured, so
  // the page and the list cannot disagree about which provider is open.
  const [provider, setProvider] = useState<ProviderDraft>();
  const routeSection = sectionIdOf(route?.pattern);
  const current =
    sections.find((item) => item.id === routeSection) ?? sections[0];
  const sectionHost = useSectionHost(
    isSectionId(routeSection) ? routeSection : undefined,
  );
  const links = linkHosts.useHosts();
  // R-9.8: the section the route shows is named by its own link, so a
  // section another bundle adds is headed by its label and icon too.
  const activeLink = links.find(
    (link) => link.props.path !== undefined && link.props.path === route?.path,
  );
  const sectionLabel = activeLink?.props.label ?? current.label;
  // The one icon the section is named by, drawn by the nav, the section heading
  // and the provider page alike, so they never drift.
  const Icon =
    sectionIcon(activeLink?.props.icon ?? current.icon) ?? AlertCircleIcon;
  const { draft, flush, setDraft } = config;

  // R-9.8: `settings.config/v1` reads and writes this same draft.
  useEffect(() => {
    configBridge.publish({ draft, setDraft });
  }, [draft, setDraft]);
  useEffect(() => () => configBridge.publish(undefined), []);
  // A section is where the chain starts over, so a provider page opened under
  // the previous one does not stay half-open behind the new section.
  const shownSection = useRef(current.id);
  if (shownSection.current !== current.id) {
    shownSection.current = current.id;
    if (provider !== undefined) setProvider(undefined);
  }
  // What the heading names: the section's own while its list shows, and the
  // provider page's while one is open. The breadcrumb carries the provider's own
  // name, so the heading says which page this is rather than repeating it.
  const title =
    provider === undefined
      ? sectionLabel
      : provider.index === undefined
        ? 'Add provider'
        : 'Edit provider';
  // The chain the window's bar draws, outermost first. The section is a control
  // while a provider page sits under it, and the page itself is the last part,
  // which is where the chain already is.
  const trail: readonly SettingsCrumb[] = [
    { label: 'Settings' },
    provider === undefined
      ? { label: sectionLabel }
      : { label: sectionLabel, onSelect: () => setProvider(undefined) },
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
  // so the window's close waits for this answer (the platform's flush phase,
  // bounded by its deadline); a `beforeunload` listener would race the teardown
  // instead. The handler is bound while the page is mounted, because the hook's
  // `flush` reads the live draft.
  useEffect(() => {
    const registration = services
      .use(HooksV1)
      .use(WindowHooksV1)
      .onFlushHook(() => flush());
    return () => registration.dispose();
  }, [services, flush]);

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

  const selectSection = (path: string): void => {
    // Selecting the section already showing still closes its provider page.
    setProvider(undefined);
    services.use(NavigationV1).navigate(path);
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

  // A finished sign-in names its credential on the open `claude` provider
  // page: the hook settled it into the credentials cache before it published
  // it, so this render's `changeProvider` already sees it in
  // `credentials.list` and the commit is one the host accepts. A `.then` on the login promise would close over
  // the stale list the promise started with, which is why the answer travels
  // as state through an effect instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the auto-select commits once, when a sign-in answers, never on the renders that recreate `changeProvider` and `provider`; the answer it commits is the live draft.
  useEffect(() => {
    const signed = claudeLogin.signedIn;
    if (signed === undefined) return;
    claudeLogin.acknowledge();
    // Only a `claude` page takes the token: the sign-in may answer after the
    // window moved to another provider, which would then send a Claude token.
    if (provider?.kind === 'claude') {
      changeProvider({
        ...provider,
        configuration: { ...provider.configuration, token: signed.id },
      });
    }
  }, [claudeLogin.signedIn]);

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

  // Every row the region lists, searched by its label and description.
  const matching = new Set(
    filterSettingsSections(
      links.map((link) => ({
        link,
        label: link.props.label ?? '',
        ...(link.props.description === undefined
          ? {}
          : { description: link.props.description }),
      })),
      query,
    ).map((entry) => entry.link),
  );
  const activePath = route?.path;

  const body =
    current.id === 'providers' &&
    provider !== undefined &&
    draft !== undefined ? (
      <SettingsProviderScreen
        claudeLogin={claudeLoginAvailable ? claudeLogin : undefined}
        credentials={credentials.list}
        draft={provider}
        kinds={kinds.list}
        onChange={changeProvider}
      />
    ) : draft === undefined ? undefined : (
      <Section
        credentials={credentials}
        draft={draft}
        id={current.id}
        kinds={kinds.list}
        onAdd={addProviderPage}
        onChange={config.setDraft}
        onEdit={editProvider}
      />
    );

  return (
    <SettingsWindow
      trail={trail}
      onBack={provider === undefined ? undefined : () => setProvider(undefined)}
      nav={
        <>
          <core-region name="settings.sections" />
          {links.map((link, index) => {
            if (!matching.has(link)) return null;
            const LinkIcon = sectionIcon(link.props.icon);
            const path = link.props.path;
            return createPortal(
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={path !== undefined && path === activePath}
                  onClick={() => {
                    if (path !== undefined) selectSection(path);
                  }}
                >
                  {LinkIcon !== undefined && <LinkIcon />}
                  <span>{link.props.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>,
              link.element,
              link.props.path ?? String(index),
            );
          })}
        </>
      }
      navEmpty={matching.size === 0}
      onQueryChange={setQuery}
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
      <div role="none" onBlur={() => void flush()}>
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
        ) : (
          <core-outlet />
        )}
        {body !== undefined &&
          sectionHost !== undefined &&
          createPortal(body, sectionHost, current.id)}
      </div>
    </SettingsWindow>
  );
}
