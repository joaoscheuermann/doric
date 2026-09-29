import type { ProviderKind } from '@/domain/config';
import { messageFrom } from '@/domain/workspace';
import { useEffect, useState } from 'react';

/**
 * The provider catalog the host declares, and how its read is going. The catalog
 * is one read of a host capability: it names the kinds a provider may be, so the
 * renderer draws whatever arrives rather than a list of types it already knows.
 */
export type ProviderKinds = {
  /** The declared kinds, in the order the host lists them. */
  readonly list: readonly ProviderKind[];
  readonly loading: boolean;
  /** The last failure, which a section shows above its own controls. */
  readonly error?: string;
};

/**
 * Reads the host's provider catalog once, when the surface mounts. The catalog
 * outlives every window and never changes while the host runs, so there is
 * nothing to reload: a failed read is the one thing a surface reports, because
 * without it no provider can be drawn.
 */
export const useProviderKinds = (): ProviderKinds => {
  const [list, setList] = useState<readonly ProviderKind[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setLoading(true);
    void window.doric.providers
      .kinds()
      .then((kinds) => {
        if (!active) return;
        setList(kinds);
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (active) setError(messageFrom(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { list, loading, error };
};
