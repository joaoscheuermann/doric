import { Popover, PopoverContent, PopoverTrigger } from 'desktop/ui/popover';
import { svgMask } from 'desktop/ui/svg-mask';
import { useId } from 'react';

import type { ResourcesReads } from '../api/resources.js';
import { CLOUD_FILL_SVG, CLOUD_OFF_FILL_SVG } from './cloud-glyphs.js';
import {
  ResourcesPopoverBody,
  useResourcesSnapshot,
} from './resource-monitor.js';

/**
 * The badge's tone, as its `data-status` carries it:
 * - `connected`: connected, no warning;
 * - `disconnected`: not connected, whatever the readings say;
 * - `warning`: connected, and the sandbox or the machine reading has
 *   `memoryWarning` (≥ 85 % of the limit, `memorySaturationRatio`) or
 *   `cpuWarning` (`cpuSustainedReadings` consecutive readings ≥
 *   `cpuSaturationPercent`) set.
 */
export type ConnectionTone = 'connected' | 'disconnected' | 'warning';

export interface ConnectionBadgeProps {
  /** The reads polled while the badge is mounted (`createResourcesReads`). */
  readonly reads: ResourcesReads;
  /** The Project whose sandbox is read. Without one, only the machine is polled. */
  readonly projectId?: string;
  /**
   * `layout.workspace/v1.connected()`. Callers pass `false` when that contract
   * has no provider (G10).
   */
  readonly connected: boolean;
}

const maskOf = (svg: string): string =>
  `${svgMask(svg)} center / contain no-repeat`;

const statusStyle: Record<
  ConnectionTone,
  { readonly svg: string; readonly color: string }
> = {
  connected: { svg: CLOUD_FILL_SVG, color: 'var(--paper-green)' },
  disconnected: { svg: CLOUD_OFF_FILL_SVG, color: 'var(--paper-red)' },
  warning: { svg: CLOUD_FILL_SVG, color: 'var(--warning)' },
};

/**
 * The connection badge (P19, UR24; Figma `266:21655` Connected, `267:21898`
 * Disconnected) and the resources popover it opens (`32:1463`).
 *
 * Renders, with no click needed:
 * - `<button type="button" data-slot="connection-badge"
 *   data-status={ConnectionTone} aria-label="Connection and resources"
 *   aria-describedby={descriptionId}>`, 14×14 (`size-3.5`), no background of
 *   its own, with the focus ring `outline-none focus-visible:ring-2
 *   focus-visible:ring-ring rounded-sm`. It is its own Tab stop.
 * - Inside it, two `aria-hidden="true"` spans, in this order, each with inline
 *   `mask` and `WebkitMask` = `${svgMask(svg)} center / contain no-repeat` and
 *   an inline `backgroundColor`:
 *   - `data-slot="connection-badge-cutout"`: `CLOUD_FILL_SVG` on
 *     `var(--sidebar)`, `absolute inset-0 size-3.5` (14×14);
 *   - `data-slot="connection-badge-status"`: `absolute top-0.5 left-0.5
 *     size-2.5` (10×10, inset 2 px), with
 *     - `CLOUD_FILL_SVG` on `var(--paper-green)` when `connected`;
 *     - `CLOUD_OFF_FILL_SVG` on `var(--paper-red)` when `disconnected`;
 *     - `CLOUD_FILL_SVG` on `var(--warning)` when `warning`.
 * - A visually hidden span (`sr-only`, id = `descriptionId`) holding the
 *   accessible description: "Connected" or "Disconnected", then " · memory high"
 *   if any section's `memoryWarning` is set and " · CPU high" if any section's
 *   `cpuWarning` is set, in that order. Warnings are added only while connected.
 *
 * Clicking the button opens a `Popover` (`desktop/ui/popover`) whose content
 * (256 px, `w-64`) is `ResourcesPopoverBody`.
 *
 * Polling (`useResourcesSnapshot`, which holds `useHostResources`,
 * `useProjectResources` and `useCpuSustain`) runs in the badge, which stays
 * mounted, not in the popover. Readings, the tone and the description keep
 * updating while the popover is closed.
 *
 * A failed read keeps the last value, as `useQuery` does. The badge itself does
 * not throw.
 */
export function ConnectionBadge({
  reads,
  projectId,
  connected,
}: ConnectionBadgeProps) {
  const snapshot = useResourcesSnapshot(reads, projectId);
  const descriptionId = useId();

  const memoryHigh =
    snapshot.sandbox.memoryWarning || snapshot.machine.memoryWarning;
  const cpuHigh = snapshot.sandbox.cpuWarning || snapshot.machine.cpuWarning;
  const tone: ConnectionTone = !connected
    ? 'disconnected'
    : memoryHigh || cpuHigh
      ? 'warning'
      : 'connected';
  const description = connected
    ? [
        'Connected',
        ...(memoryHigh ? ['memory high'] : []),
        ...(cpuHigh ? ['CPU high'] : []),
      ].join(' · ')
    : 'Disconnected';

  const cutout = maskOf(CLOUD_FILL_SVG);
  const status = maskOf(statusStyle[tone].svg);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-slot="connection-badge"
            data-status={tone}
            aria-label="Connection and resources"
            aria-describedby={descriptionId}
            className="relative block size-3.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <span
          aria-hidden="true"
          data-slot="connection-badge-cutout"
          className="absolute inset-0 size-3.5"
          style={{
            mask: cutout,
            WebkitMask: cutout,
            backgroundColor: 'var(--sidebar)',
          }}
        />
        <span
          aria-hidden="true"
          data-slot="connection-badge-status"
          className="absolute top-0.5 left-0.5 size-2.5"
          style={{
            mask: status,
            WebkitMask: status,
            backgroundColor: statusStyle[tone].color,
          }}
        />
      </PopoverTrigger>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-64 max-w-[calc(100vw-1rem)] p-3"
      >
        <ResourcesPopoverBody connected={connected} snapshot={snapshot} />
      </PopoverContent>
    </Popover>
  );
}
