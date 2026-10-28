import { NavigationV1, type Services } from 'bundle/contracts';
import { Alert, AlertDescription, AlertTitle } from 'desktop/ui/alert';
import { SidebarMenuButton, SidebarMenuItem } from 'desktop/ui/sidebar';
import { Skeleton } from 'desktop/ui/skeleton';
import { AlertCircleIcon } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { sectionIcon } from '../components/molecules/section-icon.js';
import { SettingsCredentials } from '../components/organisms/settings-credentials.js';
import { SettingsExecution } from '../components/organisms/settings-execution.js';
import { SettingsProfile } from '../components/organisms/settings-profile.js';
import { SettingsProviderScreen } from '../components/organisms/settings-provider.js';
import { SettingsProviders } from '../components/organisms/settings-providers.js';
import { SettingsTools } from '../components/organisms/settings-tools.js';
import type { SettingsCrumb } from '../components/templates/settings-surface.js';
import { SettingsWindow } from '../components/templates/settings-window.js';
import {
  type Configuration,
  type ProviderKind,
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
import { useConfigAutosave } from '../hooks/use-config-autosave.js';
import { type Credentials, useCredentials } from '../hooks/use-credentials.js';
import { useProviderKinds } from '../hooks/use-provider-kinds.js';
import { useProviderPage } from '../hooks/use-provider-page.js';
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
    case 'profile':
      return <SettingsProfile draft={draft} onChange={onChange} />;
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
  const profile = sectionHosts.profile.useHosts();
  const providers = sectionHosts.providers.useHosts();
  const execution = sectionHosts.execution.useHosts();
  const tools = sectionHosts.tools.useHosts();
  const credentials = sectionHosts.credentials.useHosts();
  const hosts = { profile, providers, execution, tools, credentials };
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
  // while that section shows its list.
  const page = useProviderPage({
    config,
    kinds: kinds.list,
    credentials: credentials.list,
    claudeLogin,
  });
  const provider = page.provider;
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
    if (provider !== undefined) page.close();
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
      : { label: sectionLabel, onSelect: page.close },
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
  useConfigAutosave(services, config);

  const selectSection = (path: string): void => {
    // Selecting the section already showing still closes its provider page.
    page.close();
    services.use(NavigationV1).navigate(path);
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
        onChange={page.change}
      />
    ) : draft === undefined ? undefined : (
      <Section
        credentials={credentials}
        draft={draft}
        id={current.id}
        kinds={kinds.list}
        onAdd={page.openNew}
        onChange={config.setDraft}
        onEdit={page.open}
      />
    );

  return (
    <SettingsWindow
      trail={trail}
      onBack={provider === undefined ? undefined : page.close}
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
          <h1 className="text-lg">{title}</h1>
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
