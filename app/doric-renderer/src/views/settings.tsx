import { SettingsCredentials } from '@/components/organisms/settings-credentials';
import { SettingsExecution } from '@/components/organisms/settings-execution';
import { SettingsProviders } from '@/components/organisms/settings-providers';
import { SettingsVersioning } from '@/components/organisms/settings-versioning';
import type { SettingsNavItem } from '@/components/templates/settings-surface';
import { SettingsWindow } from '@/components/templates/settings-window';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type Configuration,
  type ProviderKind,
  updatedAtLabel,
} from '@/domain/config';
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
 * carries the heading and the sentence a reader sees above its own controls, so
 * a screen cannot be added without saying what it is for.
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
 * so a section is one nav entry and one case here.
 */
function Section({
  credentials,
  draft,
  id,
  kinds,
  onChange,
}: {
  readonly credentials: Credentials;
  readonly draft: Configuration;
  readonly id: SectionId;
  readonly kinds: readonly ProviderKind[];
  readonly onChange: (next: Configuration) => void;
}) {
  switch (id) {
    case 'providers':
      return (
        <SettingsProviders
          credentials={credentials.list}
          draft={draft}
          kinds={kinds}
          onChange={onChange}
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
 */
export function Settings() {
  const credentials = useCredentials();
  const kinds = useProviderKinds();
  const config = useConfig(true, kinds.list);
  const [section, setSection] = useState<SectionId>('providers');
  const current = sections.find((item) => item.id === section) ?? sections[0];
  // The one icon the section is named by, drawn by the nav and the heading alike
  // so the two never drift.
  const Icon = current.icon;
  const { draft, flush } = config;
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
    if (match !== undefined) setSection(match.id);
  };

  return (
    <SettingsWindow
      activeId={current.id}
      title={current.label}
      nav={sections}
      onSelect={selectSection}
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
          Every screen states what it is and what it is for, above its own
          controls. The heading is an `<h1>` because the window holds one section
          at a time, so the section is the page of this surface. The section's own
          icon leads it, the same one the nav draws beside this label, so the two
          name one section rather than two that happen to share a word.
        */}
        <header className="mb-4 flex items-start gap-2">
          <Icon aria-hidden className="mt-0.5 size-5 shrink-0" />
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-medium">{current.label}</h1>
            <p className="text-sm text-muted-foreground">
              {current.description}
            </p>
          </div>
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
          <Section
            credentials={credentials}
            draft={draft}
            id={current.id}
            kinds={kinds.list}
            onChange={config.setDraft}
          />
        )}
      </div>
    </SettingsWindow>
  );
}

export default Settings;
