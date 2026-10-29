// The `drawio` desktopMain part: provides `drawio.svg/v1` and registers the
// flush of the `drawio-diagram` comment kind whenever chat's optional
// `chat.composer/v1` is active.

import type { Cleanup, DesktopContext } from 'bundle/contracts';

import { ChatComposerV1 } from '../contracts/chat.js';
import { DRAWIO_COMMENT_KIND } from '../contracts/index.js';
import { drawioFlush } from './comment-flush.js';
import { svgCacheService } from './svg-cache.js';

/**
 * Provides `svgCacheService()` and, through `services.whenAvailable(ChatComposerV1, …)`,
 * registers `{ kind: DRAWIO_COMMENT_KIND, flush: drawioFlush }` with each
 * composer that becomes available. Without a composer it registers nothing
 * and does not fail. The cleanup disposes the registration watch (and so each
 * registration) and the provided service.
 */
export const activate = ({ services }: DesktopContext): Cleanup => {
  const svg = services.provide(svgCacheService());

  const flush = services.whenAvailable(ChatComposerV1, (composer) => {
    const registration = composer.registerFlush({
      kind: DRAWIO_COMMENT_KIND,
      flush: drawioFlush,
    });

    return () => registration.dispose();
  });

  return () => {
    flush.dispose();
    svg.dispose();
  };
};

export { drawioFlush } from './comment-flush.js';
export {
  DiagramSvgCache,
  type SvgCacheDeps,
  svgCacheService,
} from './svg-cache.js';
