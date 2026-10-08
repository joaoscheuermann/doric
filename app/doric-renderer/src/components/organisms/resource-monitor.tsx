import { CpuIcon, MemoryStickIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { ToolbarDivider } from '@/components/molecules/toolbar-divider';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  type ContainerResources,
  cpuLabel,
  freshnessLabel,
  type HostResources,
  memoryLabel,
  resourceNotice,
  severity,
} from '@/domain/resources';
import {
  useCpuSustain,
  useHostResources,
  useProjectResources,
} from '@/hooks/use-resources';
import { cn } from '@/utility/utils';

/**
 * The footer's resource monitor: one control for the selected Project's sandbox
 * and one for the machine Doric runs on, each a snapshot the host answers with on
 * a poll. It is read-only and quiet — a value, a dash when the host cannot say,
 * and a warning tone only on the value that crossed its threshold. Nothing here
 * animates, announces or toasts: a failed read keeps the last value rather than
 * flashing an empty state.
 */
export function ResourceMonitor({
  projectId,
}: {
  readonly projectId?: string;
}) {
  const host = useHostResources();
  const project = useProjectResources(projectId);

  const container: ContainerResources | undefined =
    project.data?.status === 'ready' ? project.data.container : undefined;

  const containerCpu = useCpuSustain(container?.at, container?.cpuPercent);
  const hostCpu = useCpuSustain(host.data?.at, host.data?.cpuPercent);

  const sandbox = containerModel(container, containerCpu, {
    subject: 'Sandbox resources',
    notice: resourceNotice(project.data),
    at: container?.at,
  });
  const machine = hostModel(host.data, hostCpu);

  return (
    <>
      <ResourceControl model={sandbox} />
      <ToolbarDivider />
      <ResourceControl model={machine} />
    </>
  );
}

/** Everything one control draws, without reaching for the DOM or a clock. */
type ResourceControlModel = {
  readonly subject: string;
  readonly memory: string;
  readonly cpu: string;
  readonly memoryWarning: boolean;
  readonly cpuWarning: boolean;
  readonly memoryRatio?: number;
  readonly cpuRatio?: number;
  readonly notice?: string;
  readonly freshness?: string;
};

const containerModel = (
  container: ContainerResources | undefined,
  cpuSustained: boolean,
  context: {
    readonly subject: string;
    readonly notice?: string;
    readonly at?: string;
  },
): ResourceControlModel =>
  controlModel({
    at: context.at,
    cpuPercent: container?.cpuPercent,
    cpuSustained,
    memoryLimitBytes: container?.memoryLimitBytes,
    memoryUsedBytes: container?.memoryUsedBytes,
    notice: context.notice,
    subject: context.subject,
  });

const hostModel = (
  host: HostResources | undefined,
  cpuSustained: boolean,
): ResourceControlModel =>
  controlModel({
    at: host?.at,
    cpuPercent: host?.cpuPercent,
    cpuSustained,
    memoryLimitBytes: host?.memoryTotalBytes,
    memoryUsedBytes: host?.memoryUsedBytes,
    subject: 'Machine resources',
  });

const controlModel = (input: {
  readonly subject: string;
  readonly at?: string;
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number;
  readonly cpuPercent?: number;
  readonly cpuSustained: boolean;
  readonly notice?: string;
}): ResourceControlModel => ({
  subject: input.subject,
  memory: memoryLabel(input.memoryUsedBytes, input.memoryLimitBytes),
  cpu: cpuLabel(input.cpuPercent),
  memoryWarning:
    severity({
      memoryLimitBytes: input.memoryLimitBytes,
      memoryUsedBytes: input.memoryUsedBytes,
    }) === 'warning',
  // Only the sustained cpu verdict warns, never a single hot reading.
  cpuWarning: input.cpuSustained,
  memoryRatio: ratio(input.memoryUsedBytes, input.memoryLimitBytes),
  cpuRatio:
    input.cpuPercent !== undefined && Number.isFinite(input.cpuPercent)
      ? input.cpuPercent / 100
      : undefined,
  notice: input.notice,
  freshness: input.at === undefined ? undefined : freshnessLabel(input.at),
});

const ratio = (used?: number, limit?: number): number | undefined =>
  used !== undefined && limit !== undefined && limit > 0
    ? Math.min(1, Math.max(0, used / limit))
    : undefined;

/**
 * One monitored subject: a ghost button carrying its memory and cpu values, a
 * tooltip that names the subject and its staleness, and a popover with the gauge
 * the resting control does not draw.
 */
function ResourceControl({ model }: { readonly model: ResourceControlModel }) {
  const ariaLabel = `${model.subject}: memory ${model.memory}, cpu ${model.cpu}`;
  const tooltip = [model.subject, model.notice, model.freshness]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="min-w-0 shrink gap-1.5"
              aria-label={ariaLabel}
            >
              <span
                className={cn(
                  'min-w-0 truncate tabular-nums',
                  model.memoryWarning
                    ? 'text-warning'
                    : 'text-muted-foreground',
                )}
              >
                {model.memory}
              </span>
              <span className="text-muted-foreground">·</span>
              <span
                className={cn(
                  'min-w-0 truncate tabular-nums',
                  model.cpuWarning ? 'text-warning' : 'text-muted-foreground',
                )}
              >
                {model.cpu}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        className="w-64 max-w-[calc(100vw-1rem)] gap-2 p-3"
      >
        {model.notice ? (
          <span className="text-xs text-muted-foreground">{model.notice}</span>
        ) : (
          <>
            <Gauge
              icon={<MemoryStickIcon />}
              label="Memory"
              ratio={model.memoryRatio}
              value={model.memory}
              warning={model.memoryWarning}
            />
            <Gauge
              icon={<CpuIcon />}
              label="CPU"
              ratio={model.cpuRatio}
              value={model.cpu}
              warning={model.cpuWarning}
            />
          </>
        )}
        {model.freshness && (
          <span className="text-xs text-muted-foreground">
            {model.freshness}
          </span>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One labelled reading with its own quiet gauge, drawn only in the popover. */
function Gauge({
  icon,
  label,
  ratio,
  value,
  warning,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly ratio?: number;
  readonly value: string;
  readonly warning: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground [&_svg]:size-3">{icon}</span>
        <span className="text-muted-foreground">{label}</span>
        <span
          className={cn(
            'ml-auto tabular-nums',
            warning ? 'text-warning' : 'text-foreground',
          )}
        >
          {value}
        </span>
      </div>
      {ratio !== undefined && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full', warning ? 'bg-warning' : 'bg-primary')}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
