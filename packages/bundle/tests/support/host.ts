import {
  AppHooksV1,
  bindRegistrant,
  type ContractTool,
  HooksV1,
  type HostContext,
  type Services,
  SkillsV1,
  ToolsV1,
} from '../../src/contracts/index.js';
import {
  type Composition,
  type EmbeddedBundle,
  type HostPlatform,
  startHost,
} from '../../src/index.js';
import {
  type CapturedLog,
  type CapturedSink,
  captureLog,
  captureSink,
} from './fixtures.js';

/** A registrable tool that records the services it was bound to. */
export const fakeTool = (name: string, bound: Services[] = []) => {
  const definition = {
    name,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  };

  return {
    name,
    definition,
    [bindRegistrant]: (services: Services): ContractTool => {
      bound.push(services);

      return {
        name,
        definition,
        input: undefined as never,
        output: undefined as never,
        settings: [],
        execute: async () => {
          await Promise.resolve();

          return {};
        },
      };
    },
  };
};

export interface Started {
  readonly platform: HostPlatform;
  readonly log: CapturedLog;
  readonly sink: CapturedSink;
}

export const start = async (options: {
  readonly bundlesPath: string;
  readonly composition: Partial<Composition> | { readonly path: string };
  readonly embedded?: readonly EmbeddedBundle[];
}): Promise<Started> => {
  const log = captureLog();
  const sink = captureSink();
  const composition =
    'path' in options.composition
      ? (options.composition as { path: string })
      : {
          core: 'mincore',
          enabled: ['mincore'],
          providers: {},
          ...(options.composition as Partial<Composition>),
        };
  const platform = await startHost({
    bundlesPath: options.bundlesPath,
    composition: composition as Composition,
    embedded: options.embedded ?? [],
    log,
    sink,
  });

  return { platform, log, sink };
};

export const toolNames = (platform: HostPlatform) =>
  platform.services
    .use(ToolsV1)
    .list()
    .map(({ tool, bundleId }) => `${bundleId}:${tool.name}`);

export const skillNames = async (platform: HostPlatform) =>
  (await platform.services.use(SkillsV1).list()).map(
    ({ skill, bundleId, alwaysAvailable }) =>
      `${bundleId}:${skill.name}:${alwaysAvailable}`,
  );

export const states = (platform: HostPlatform) =>
  Object.fromEntries(
    platform.diagnostics().bundles.map(({ id, state }) => [id, state]),
  );

export const reasonCodes = (platform: HostPlatform, id: string) =>
  platform
    .diagnostics()
    .bundles.find((bundle) => bundle.id === id)
    ?.reasons.map(({ code }) => code);

/** Records AppHooksV1 activation events seen by a bundle's handler. */
export const observeActivations =
  (seen: string[]) =>
  ({ services }: HostContext) => {
    services
      .use(HooksV1)
      .use(AppHooksV1)
      .onActivateHook(({ bundleId }) => {
        seen.push(bundleId);
      });
  };
