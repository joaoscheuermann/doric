// Where a preview's frame document comes from: the platform's frame document
// (`doric://app/frame/index.html`) running this bundle's own preview runtime,
// `client/frames/preview.js`, which the bundle build emits beside the
// client's `index.js` (docs/architecture/bundles/papercraft/isolamento.md).
//
// The runtime's URL is resolved against this module's own URL, the way the
// platform's client code finds its workers: the client is one bundled
// `client/index.js` served at `doric://app/bundles/papercraft@<version>/`, so
// `./frames/preview.js` is the runtime of the very version that is running.
// This file sits at the client's root so the path reads the same from the
// source and from the bundle.

import { frameDocumentUrl } from './frame-protocol.js';

/** The URL of this bundle's preview runtime, `…/client/frames/preview.js`. */
export const previewRuntimeUrl = (): string =>
  new URL('./frames/preview.js', import.meta.url).href;

/** The `src` of every preview's iframe. */
export const previewFrameSrc = (): string =>
  frameDocumentUrl(previewRuntimeUrl());
