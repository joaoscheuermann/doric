import { svgMask } from 'desktop/ui/svg-mask';
import { cn } from 'desktop/ui/utils';
import { CpuIcon, MemoryStickIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ResourcesReads } from '../api/resources.js';
import {
  type ContainerResources,
  cpuLabel,
  freshnessLabel,
  type HostResources,
  memoryLabel,
  resourceNotice,
  severity,
} from '../domain/resources.js';
import {
  useCpuSustain,
  useHostResources,
  useProjectResources,
} from '../hooks/use-resources.js';
import { CLOUD_FILL_SVG, CLOUD_OFF_FILL_SVG } from './cloud-glyphs.js';

/**
 * One section of the resources popover, Sandbox or Machine, as the last poll
 * left it. It holds no DOM and reads no clock.
 */
export interface ResourceSectionModel {
  /** The section heading. */
  readonly title: 'Sandbox' | 'Machine';
  /** `memoryLabel(used, limit)`: "1.2 / 4 GiB", the used value alone without a limit, or "—". */
  readonly memory: string;
  /** `cpuLabel(percent)`: "23%" or "—". */
  readonly cpu: string;
  /** `severity(...) === 'warning'`: memory ≥ `memorySaturationRatio` of its limit. */
  readonly memoryWarning: boolean;
  /** The sustained cpu verdict of `useCpuSustain`, never a single hot reading. */
  readonly cpuWarning: boolean;
  /** used/limit clamped to [0, 1]; absent without both. */
  readonly memoryRatio?: number;
  /** percent/100; absent without a finite percent. */
  readonly cpuRatio?: number;
  /**
   * Sandbox only: `resourceNotice(result)`, which is "Preparing environment…",
   * "Environment unavailable" or "Resources unavailable in this provider" (G11).
   * When set, the section shows the sentence in place of its gauges.
   */
  readonly notice?: string;
}

/** Everything the badge and its popover draw for one poll. */
export interface ResourcesSnapshot {
  readonly sandbox: ResourceSectionModel;
  readonly machine: ResourceSectionModel;
  /**
   * The reading the header's freshness is measured from: the sandbox reading's
   * `at` (`:52`), else the machine reading's (`:102`). Absent when neither has
   * a reading.
   */
  readonly at?: string;
}

/**
 * Polls `reads` while mounted: the host every 3 s, and the Project's sandbox
 * while `projectId` is set, at the pending hint otherwise (`use-resources.ts`).
 * It returns the current snapshot. The cpu verdicts advance once per new
 * reading `at`, never on a re-render. It needs a `QueryClientProvider` above it
 * and does not throw.
 */
export const useResourcesSnapshot = (
  reads: ResourcesReads,
  projectId: string | undefined,
): ResourcesSnapshot => {
  const host = useHostResources(reads);
  const project = useProjectResources(reads, projectId);

  const container: ContainerResources | undefined =
    project.data?.status === 'ready' ? project.data.container : undefined;

  const containerCpu = useCpuSustain(container?.at, container?.cpuPercent);
  const hostCpu = useCpuSustain(host.data?.at, host.data?.cpuPercent);

  return {
    sandbox: containerModel(
      container,
      containerCpu,
      resourceNotice(project.data),
    ),
    machine: hostModel(host.data, hostCpu),
    at: container?.at ?? host.data?.at,
  };
};

const containerModel = (
  container: ContainerResources | undefined,
  cpuSustained: boolean,
  notice: string | undefined,
): ResourceSectionModel =>
  controlModel({
    cpuPercent: container?.cpuPercent,
    cpuSustained,
    memoryLimitBytes: container?.memoryLimitBytes,
    memoryUsedBytes: container?.memoryUsedBytes,
    notice,
    title: 'Sandbox',
  });

const hostModel = (
  host: HostResources | undefined,
  cpuSustained: boolean,
): ResourceSectionModel =>
  controlModel({
    cpuPercent: host?.cpuPercent,
    cpuSustained,
    memoryLimitBytes: host?.memoryTotalBytes,
    memoryUsedBytes: host?.memoryUsedBytes,
    title: 'Machine',
  });

const controlModel = (input: {
  readonly title: ResourceSectionModel['title'];
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number;
  readonly cpuPercent?: number;
  readonly cpuSustained: boolean;
  readonly notice?: string;
}): ResourceSectionModel => ({
  title: input.title,
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
});

const ratio = (used?: number, limit?: number): number | undefined =>
  used !== undefined && limit !== undefined && limit > 0
    ? Math.min(1, Math.max(0, used / limit))
    : undefined;

/**
 * The popover's body (`32:1463`) with no popover around it, so a story can show
 * any state of `176:394`. It renders, in order:
 * - `data-slot="resources-popover-header"`:
 *   - when `connected` and `snapshot.at` is set, "Connected · " +
 *     `freshnessLabel(snapshot.at)` ("Connected · Updated 2s ago");
 *   - when connected without `at`, "Connected";
 *   - when not connected, "Disconnected".
 * - A "Sandbox" section, then a "Machine" section. Each shows its `notice` or
 *   the Memory and CPU gauges (`Gauge`, `32:1377`) in the warning tone of their
 *   flags.
 *
 * The freshness reads the wall clock at render, so it advances with each poll's
 * re-render.
 */
export function ResourcesPopoverBody({
  connected,
  snapshot,
}: {
  readonly connected: boolean;
  readonly snapshot: ResourcesSnapshot;
}) {
  const freshness =
    connected && snapshot.at !== undefined
      ? freshnessLabel(snapshot.at)
      : undefined;
  const glyph = connected ? CLOUD_FILL_SVG : CLOUD_OFF_FILL_SVG;
  const mask = `${svgMask(glyph)} center / contain no-repeat`;

  return (
    <div className="flex flex-col gap-3 text-xs leading-4 font-light">
      <div
        data-slot="resources-popover-header"
        className="flex items-center gap-1.5"
      >
        <span
          aria-hidden="true"
          className="size-3 shrink-0"
          style={{
            mask,
            WebkitMask: mask,
            backgroundColor: connected
              ? 'var(--paper-green)'
              : 'var(--paper-red)',
          }}
        />
        <span className="text-foreground">
          {connected ? 'Connected' : 'Disconnected'}
        </span>
        {freshness && (
          <>
            <span className="sr-only"> · </span>
            <span className="ml-auto text-muted-foreground">{freshness}</span>
          </>
        )}
      </div>
      <div className="h-px w-full bg-foreground/10" />
      <ResourceSection model={snapshot.sandbox} dimmed={!connected} />
      <ResourceSection model={snapshot.machine} dimmed={!connected} />
    </div>
  );
}

/** One titled section: its notice, or its Memory and CPU gauges. */
function ResourceSection({
  model,
  dimmed,
}: {
  readonly model: ResourceSectionModel;
  readonly dimmed: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-2', dimmed && 'opacity-50')}>
      <span className="text-foreground">{model.title}</span>
      {model.notice ? (
        <span className="text-muted-foreground">{model.notice}</span>
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
    </div>
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
      <div className="flex items-center gap-1.5">
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
