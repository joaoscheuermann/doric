// The `papercraft` desktopMain part: registers `papercraft.open-canvas/v1`,
// provides `papercraft.snapshot/v1` (a window's capture of its own pixels) and
// registers the flush of the `papercraft-preview` comment kind.
//
// The flush is registered here because `chat.composer/v1.registerFlush` carries
// a function and only serves the main process: when the send of a prompt drains
// the stack, the composer service calls this flush, and it answers the durable
// `comments/v1.add` writes the sender window then performs — chat never learns
// what a preview comment is. The composer is chat's and optional: the flush is
// registered whenever it is active, and a composition without chat still opens
// the canvas.

import { join } from 'node:path';

import {
  type Call,
  type Cleanup,
  CommandsV1,
  type DesktopContext,
  DoricCacheV1,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';

import {
  type ModuleCacheEntry,
  PapercraftCacheV1,
  papercraftCacheMethods,
} from '../contracts/cache.js';
import { ChatComposerV1 } from '../contracts/chat.js';
import {
  PAPERCRAFT_COMMENT_KIND,
  PROGRAM_COMMENT_KIND,
} from '../contracts/index.js';
import { ModulesCache } from './cache.js';
import { openCanvas } from './commands.js';
import { papercraftFlush, programFlush } from './comment-flush.js';
import { snapshotService } from './snapshot.js';

export const activate = ({ services }: DesktopContext): Cleanup => {
  const command = services.use(CommandsV1).register(openCanvas);
  const snapshot = services.provide(snapshotService());

  // `papercraft.cache/v1` (D14): the directory is read at the first call,
  // since this activation also runs at build time, where `doric.*` answers
  // nothing.
  let cache: Promise<ModulesCache> | undefined;
  const cacheOf = (call: Call, used: Services) => {
    cache ??= used
      .use(DoricCacheV1)
      .directory(call)
      .then((root) => new ModulesCache(root, join(root, '.tmp')));

    return cache;
  };
  const modules = services.provide(
    defineService(PapercraftCacheV1, {
      ensure: defineMethod({
        ...papercraftCacheMethods.ensure,
        execute: (
          input: { readonly entries: readonly ModuleCacheEntry[] },
          call: Call,
          used: Services,
        ) => cacheOf(call, used).then((one) => one.ensure(input)),
      }),
    }),
  );

  const flush = services.whenAvailable(ChatComposerV1, (composer) => {
    const registrations = [
      composer.registerFlush({
        kind: PAPERCRAFT_COMMENT_KIND,
        flush: papercraftFlush,
      }),
      composer.registerFlush({
        kind: PROGRAM_COMMENT_KIND,
        flush: programFlush,
      }),
    ];

    return () => {
      for (const registration of registrations) registration.dispose();
    };
  });

  return () => {
    flush.dispose();
    modules.dispose();
    snapshot.dispose();
    command.dispose();
  };
};

export { openCanvas, openCanvasInput } from './commands.js';
export { papercraftFlush, programFlush } from './comment-flush.js';
export {
  platformCapture,
  snapshotService,
  type WindowCapture,
} from './snapshot.js';
