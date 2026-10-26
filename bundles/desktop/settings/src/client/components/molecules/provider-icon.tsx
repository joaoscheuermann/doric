import { MonitorIcon, ServerIcon } from 'lucide-react';

import { providerMark } from '../../domain/provider-icon.js';
import { providerIconPaths } from './provider-icon-paths.js';

/**
 * The mark of a configured provider, in `currentColor` and hidden from
 * assistive technology (the row or heading beside it names the provider): a
 * computer when its endpoint is local, else its kind's brand mark, else a
 * generic server.
 */
export function ProviderIcon({
  kind,
  endpoint,
  className,
}: {
  readonly kind: string;
  readonly endpoint: string | undefined;
  readonly className?: string;
}) {
  const mark = providerMark(kind, endpoint);
  if (mark === 'local')
    return <MonitorIcon aria-hidden className={className} />;
  if (mark === 'server')
    return <ServerIcon aria-hidden className={className} />;
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule={mark === 'codex' ? 'evenodd' : undefined}
      className={className}
    >
      <path d={providerIconPaths[mark]} />
    </svg>
  );
}
