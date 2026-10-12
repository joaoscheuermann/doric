import type { HostContext } from 'bundle/contracts';

import { createHostConfig } from './configuration.js';

/**
 * The installed `host-config` part: the owner of the Doric configuration, which
 * the host activates like any bundle. Its secrets view and reference source are
 * local to the kernel process, so the composition runs it resident there.
 */
export const activate = (context: HostContext) =>
  createHostConfig().bundle.host?.activate(context);
