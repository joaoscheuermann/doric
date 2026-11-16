import { ErrorNotice } from 'desktop/ui/error-notice';
import { PackageXIcon } from 'lucide-react';

import { useQuarantineNotice } from '../../hooks/use-quarantine-notice.js';

/**
 * The window's one notice for the bundles its catalog reports as quarantined
 * (§7.2), drawn at the bottom of each frame's left sidebar.
 *
 * Renders nothing when `useQuarantineNotice()` answers `undefined`. Otherwise
 * one `ErrorNotice` in the default `block` variant with the `PackageXIcon`
 * icon and the notice's `error`, `catalog` and `context`: warning tone, the
 * counted title, the turned-off ids as explanation, Copy details as its only
 * action (no Retry, no dismiss), and not announced (`role="group"`), since it
 * is window state that remounts with each frame. `className` is passed to
 * the notice's root and places it in the sidebar.
 */
export function BundleHealthNotice({
  className,
}: {
  readonly className?: string;
}) {
  const notice = useQuarantineNotice();
  if (notice === undefined) return null;
  return (
    <ErrorNotice
      error={notice.error}
      icon={PackageXIcon}
      catalog={notice.catalog}
      context={notice.context}
      className={className}
    />
  );
}
