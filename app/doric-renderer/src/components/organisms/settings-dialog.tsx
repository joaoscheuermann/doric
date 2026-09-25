import { SettingsCredentials } from '@/components/organisms/settings-credentials';
import { SettingsExecution } from '@/components/organisms/settings-execution';
import { SettingsProviders } from '@/components/organisms/settings-providers';
import {
  type SettingsNavItem,
  SettingsShell,
} from '@/components/templates/settings-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { type Configuration, updatedAtLabel } from '@/domain/config';
import { type Config, useConfig } from '@/hooks/use-config';
import {
  AlertCircleIcon,
  KeyRoundIcon,
  ServerIcon,
  ZapIcon,
} from 'lucide-react';
import { useState } from 'react';

/** The sections this modal offers, in the order the nav lists them. */
const sections = [
  { icon: ServerIcon, id: 'providers', label: 'Providers' },
  { icon: ZapIcon, id: 'execution', label: 'Execution' },
  { icon: KeyRoundIcon, id: 'credentials', label: 'Credentials' },
] as const satisfies readonly SettingsNavItem[];

type SectionId = (typeof sections)[number]['id'];

export type SettingsDialogProps = {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
};

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
  draft,
  id,
  onChange,
}: {
  readonly draft: Configuration;
  readonly id: SectionId;
  readonly onChange: (next: Configuration) => void;
}) {
  switch (id) {
    case 'providers':
      return <SettingsProviders draft={draft} onChange={onChange} />;
    case 'execution':
      return <SettingsExecution draft={draft} onChange={onChange} />;
    case 'credentials':
      return <SettingsCredentials draft={draft} onChange={onChange} />;
  }
}

/**
 * The application's settings, reachable whether or not a Project or Thread is
 * selected because the configuration is one value the host owns. There is no
 * Save button: a valid change sends itself after a short pause, on a field
 * blur, and on close, and the footer reports the save instead of offering one.
 */
export function SettingsDialog({ onOpenChange, open }: SettingsDialogProps) {
  const config = useConfig(open);
  const [section, setSection] = useState<SectionId>('providers');
  const current = sections.find((item) => item.id === section) ?? sections[0];
  const { draft } = config;
  const status = saveState(config);

  // Closing flushes a pending change and lets the request settle in the
  // background; the host keeps what it received, and reopening reloads it.
  const close = (next: boolean): void => {
    if (!next) void config.flush();
    onOpenChange(next);
  };

  const selectSection = (id: string): void => {
    const match = sections.find((item) => item.id === id);
    if (match !== undefined) setSection(match.id);
  };

  return (
    <SettingsShell
      activeId={current.id}
      title={current.label}
      nav={sections}
      open={open}
      onOpenChange={close}
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
      <div onBlur={() => void config.flush()}>
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
          <Section draft={draft} id={current.id} onChange={config.setDraft} />
        )}
      </div>
    </SettingsShell>
  );
}
