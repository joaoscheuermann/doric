import { z } from 'zod';

import {
  defineMethod,
  defineService,
  type HostContext,
  ToolsV1,
} from '../../src/contracts/index.js';
import { fakeTool } from './host.js';

/**
 * Host part of an installed test bundle: provides `prov.api/v1` and registers
 * the tool `prov-tool`, so its own skills and dependents can be observed.
 */
export const activate = ({ services }: HostContext): void => {
  services.provide(
    defineService('prov.api/v1', {
      ping: defineMethod({
        input: z.tuple([]),
        output: z.literal('pong'),
        execute: () => 'pong' as const,
      }),
    }),
  );
  services
    .use(ToolsV1)
    .register(fakeTool('prov-tool'), { alwaysAvailable: true });
};
