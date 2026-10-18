// The `artifacts` bundle's desktopMain part: `artifacts.cache/v1`, the
// verified cache of a revision's compiled entries (`artifacts.md`, stage 2).
//
// A desktopMain generation resolves no host contract (a window reaches
// `artifacts/v1` over the bridge; this process does not), so the window that
// owns the fetch hands `ensure` what the host's `artifacts/v1.read` returned:
// `{ revision, entries: [{ path, sha256, base64 }] }`. Every entry is
// verified against its SHA-256 before it is written, and only then can the
// protocol's `/artifacts/<artifactId>@<revision>/…` prefix serve it.
//
// The cache reads its directory lazily, on the first call, because this
// activation is also recorded at build time, where the platform's `doric.*`
// services answer nothing at all (the `screen` desktop part's pattern).

import { join } from 'node:path';

import {
  type Call,
  type Cleanup,
  type DesktopContext,
  DoricCacheV1,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';

import {
  type ArtifactCacheEnsureInput,
  ArtifactsCacheV1,
  artifactsCacheMethods,
} from '../contracts/index.js';
import { ArtifactRevisionsCache } from './cache.js';

export const activate = ({ services }: DesktopContext): Cleanup => {
  let cache: Promise<ArtifactRevisionsCache> | undefined;

  const cacheOf = (call: Call, used: Services) => {
    cache ??= used
      .use(DoricCacheV1)
      .directory(call)
      .then((root) => new ArtifactRevisionsCache(root, join(root, '.tmp')));

    return cache;
  };

  const providing = services.provide(
    defineService(ArtifactsCacheV1, {
      ensure: defineMethod({
        ...artifactsCacheMethods.ensure,
        execute: (
          input: ArtifactCacheEnsureInput,
          call: Call,
          used: Services,
        ) => cacheOf(call, used).then((cache) => cache.ensure(input)),
      }),
    }),
  );

  return () => {
    providing.dispose();
  };
};
