// Where a papercraft fence's frame document comes from: the platform's frame
// document (`doric://app/frame/index.html`) running this bundle's own program
// runtime, `client/frames/openui.js`, which the bundle build emits beside the
// client's `index.js` (docs/architecture/bundles/papercraft/isolamento.md).
//
// The runtime's URL is resolved against this module's own URL, the way the
// platform's client code finds its workers: the client is one bundled
// `client/index.js` served at `doric://app/bundles/papercraft@<version>/`, so
// `./frames/openui.js` is the runtime of the very version that is running.
// This file sits at the client's root so the path reads the same from the
// source and from the bundle.

import { frameDocumentUrl } from './frame-protocol.js';

/**
 * The `src` of every papercraft fence's iframe: the platform's frame document
 * running this bundle's program runtime, `…/client/frames/openui.js` (D6).
 */
export const programFrameSrc = (): string =>
  frameDocumentUrl(new URL('./frames/openui.js', import.meta.url).href);
