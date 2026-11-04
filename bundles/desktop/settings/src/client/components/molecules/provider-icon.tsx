import { ServerIcon } from 'lucide-react';

import { ModelIcon } from './model-icon.js';

/**
 * A provider's own icon as the host answers it, hidden from assistive
 * technology (the row or heading beside it names the provider). An SVG draws a
 * `ModelIcon`; `null`, meaning the host answered none, draws lucide's
 * `ServerIcon`; `undefined`, meaning no answer yet, draws an empty slot of the
 * same size.
 */
export function ProviderIcon({
  svg,
  className,
}: {
  readonly svg: string | null | undefined;
  readonly className?: string;
}) {
  if (svg === null) return <ServerIcon aria-hidden className={className} />;
  return <ModelIcon svg={svg} className={className} />;
}
