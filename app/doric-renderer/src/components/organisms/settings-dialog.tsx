import { SettingsExecution } from '@/components/organisms/settings-execution';
import { SettingsProviders } from '@/components/organisms/settings-providers';
import {
  type SettingsNavItem,
  SettingsShell,
} from '@/components/templates/settings-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { updatedAtLabel } from '@/domain/config';
import { useConfig } from '@/hooks/use-config';
import { AlertCircleIcon, ServerIcon, ZapIcon } from 'lucide-react';
import { useState } from 'react';

/** The sections this modal offers, in the order the nav lists them. */
const sections = [
  { icon: ServerIcon, id: 'providers', label: 'Providers' },
  { icon: ZapIcon, id: 'execution', label: 'Execution' },
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
 * The application's settings, reachable whether or not a Project or Thread is
 * selected because the configuration is one value the host owns. Closing never
 * saves: the draft is discarded, and only Save sends it to the host.
 */
export function SettingsDialog({ onOpenChange, open }: SettingsDialogProps) {
  const config = useConfig(open);
  const [section, setSection] = useState<SectionId>('providers');
  const current = sections.find((item) => item.id === section) ?? sections[0];
  const { draft } = config;

  const close = (next: boolean): void => {
    if (!next) config.reset();
    onOpenChange(next);
  };

  const selectSection = (id: string): void => {
    const match = sections.find((item) => item.id === id);
    if (match !== undefined) setSection(match.id);
  };

  const note = config.issue ?? (config.dirty ? 'Unsaved changes.' : undefined);

  return (
    <SettingsShell
      activeId={current.id}
      title={current.label}
      nav={sections}
      open={open}
      onOpenChange={close}
      onSelect={selectSection}
      meta={
        config.saved !== undefined && (
          <span>
            Revision {config.saved.revision} · Updated{' '}
            {updatedAtLabel(config.saved.updatedAt)}
          </span>
        )
      }
      footer={
        <div className="flex w-full items-center justify-between gap-4">
          <span className="text-xs text-muted-foreground">
            {config.saving ? 'Saving…' : note}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={config.saving}
              onClick={() => close(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!config.canSave}
              onClick={() => void config.save()}
            >
              Save
            </Button>
          </div>
        </div>
      }
    >
      {config.error !== undefined && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircleIcon />
          <AlertTitle>Settings were not saved</AlertTitle>
          <AlertDescription>{config.error}</AlertDescription>
        </Alert>
      )}
      {draft === undefined ? (
        config.loading && <SectionSkeleton />
      ) : current.id === 'providers' ? (
        <SettingsProviders draft={draft} onChange={config.setDraft} />
      ) : (
        <SettingsExecution draft={draft} onChange={config.setDraft} />
      )}
    </SettingsShell>
  );
}
