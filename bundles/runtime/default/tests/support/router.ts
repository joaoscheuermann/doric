// The harness of `default`'s host part through the router (phase 3, slice
// S51d, contract §6): `executor/v1` and `default.agents/v1` served by
// `createTestRouter` as `src/host/main.ts` serves them (`createDefaultHost`),
// with recording fakes of every service the part calls: an in-memory
// `executor.session/v1`, `models/v1` relaying `Stream`/`Complete` to
// `serveProviderKind` over a scripted provider (the real S43 wire),
// `tools/v1`, `hooks/v1`, `host-config/v1`, `skills/v1`, `runtime.lease/v1`,
// `runtime.workspace/v1`, `default.skill-sources/v1` and `doric.catalog/v1`.
// Every fake call is recorded with its `callOf(context)` scope and caller.
// The fakes, wire forms and shared helpers sit in the sibling `router-*.ts`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JsonObject, JsonValue } from '@bufbuild/protobuf';
import type { Client, HandlerContext } from '@connectrpc/connect';
import { type CallScope, type ContractError, callOf } from 'bundle/contracts';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { LogService } from 'bundle/contracts/gen/doric/log/v1/log_pb.js';
import type { ProviderMessage as WireMessage } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { HostContext } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import { HostConfigService } from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import type {
  Attachment,
  ConfigurationValue,
  HistoryPatch,
  InputSource,
  SteerInput,
} from 'runtime/contracts';
import { SessionService } from 'runtime/contracts/gen/doric/executor/session/v1/session_pb.js';
import { ExecutorService } from 'runtime/contracts/gen/doric/executor/v1/executor_pb.js';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { WorkspaceService } from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';

import { AgentsService } from '../../src/contracts/gen/doric/default/agents/v1/agents_pb.js';
import { SkillSourcesService } from '../../src/contracts/gen/doric/default/skill_sources/v1/skill_sources_pb.js';
import type { AgentFile } from '../../src/host/agents/built-in.js';
import { createDefaultHost } from '../../src/host/service.js';
import {
  type FakeLease,
  type FakeSkillSource,
  type FakeWorkspace,
  type HarnessSkill,
  harnessNow,
  projectId,
  promptId,
  testConfiguration,
  threadId,
} from './harness.js';
import {
  catalogFake,
  hooksFake,
  hostConfigFake,
  leaseFake,
  skillSourceFake,
  skillsFake,
  toolsFake,
  workspaceFake,
} from './router-fakes.js';
import { modelsFake } from './router-models.js';
import { sessionFake } from './router-session.js';
import { wireSource, wireThread } from './router-wire.js';

/** The bundle directory: `dist-tests/tests/support/` is three levels below it. */
export const bundleRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The scope of every call the tests make to the bundle: the prompt's. */
export const scope: CallScope = { projectId, threadId, promptId };

/** The session id every `executor/v1` request names unless a test says otherwise. */
export const sessionId = 'session-1';

/** The services `default`'s host part declares it calls (the catalog is a platform contract). */
export const SECTION_D: readonly string[] = [
  ToolsService.typeName,
  SkillsService.typeName,
  ModelsService.typeName,
  HostConfigService.typeName,
  HooksService.typeName,
  LogService.typeName,
  SessionService.typeName,
  LeaseService.typeName,
  WorkspaceService.typeName,
  SkillSourcesService.typeName,
];

/** One call a fake received. */
export interface FakeCall {
  /** The full service name (`DescService.typeName`). */
  readonly service: string;
  /** The method's local name, as the generated client names it (`readHistory`). */
  readonly method: string;
  /** The parts of the request a test reads, as plain values. */
  readonly request: unknown;
  readonly scope: CallScope | undefined;
  /** The calling bundle's id. */
  readonly caller: string | undefined;
  /** Whether a {@link Routed.run} was in flight when the call arrived. */
  readonly running: boolean;
}

/** One `Record` as the session fake read it: the shape of the kernel's `writes`. */
export interface RecordedWrite {
  readonly history?: HistoryPatch;
  readonly event?: unknown;
}

/** One tool `tools/v1` lists, with what its `Check` and `Execute` answer. */
export interface RoutedTool {
  readonly name: string;
  readonly description?: string;
  /** Default: an object schema without properties. */
  readonly inputSchema?: JsonObject;
  /** Default: `{}`. */
  readonly outputSchema?: JsonObject;
  readonly resultModalities?: readonly string[];
  /** Default: `{success: true, data: payload}`. A throw fails the call. */
  readonly check?: (payload: JsonValue) =>
    | { readonly success: true; readonly data: JsonValue }
    | {
        readonly success: false;
        readonly issues: readonly { path: string; message: string }[];
      };
  /**
   * Default: `{}`. A throw (or rejection) fails the call (a `ContractError` keeps its code). `signal` is the
   * `Execute` handler's, aborted when the caller cancels the call.
   */
  readonly execute?: (
    payload: JsonValue,
    signal: AbortSignal,
  ) => JsonValue | undefined | Promise<JsonValue | undefined>;
}

/** One bundle the catalog lists as a provider of `default.skill-sources/v1`. */
export interface CatalogSource {
  readonly bundleId: string;
  readonly state: 'active' | 'quarantined' | 'disabled' | 'inactive';
}

export interface RoutedOptions {
  /** The scripted llms provider `serveProviderKind` builds for every provider id. */
  readonly provider: object;
  /** Default: `testConfiguration()`. */
  readonly configuration?: ConfigurationValue;
  /** What `InputModalities` answers for every model; absent: `known: false`. */
  readonly inputModalities?: readonly string[];
  readonly tools?: readonly RoutedTool[];
  readonly skills?: readonly HarnessSkill[];
  /** `runtime.lease/v1`; without it the service is declared but unserved. */
  readonly lease?: FakeLease;
  /** `runtime.workspace/v1`; without it the service is declared but unserved. */
  readonly workspace?: FakeWorkspace;
  /** The one `default.skill-sources/v1` fake (the test router ignores `provider`). */
  readonly skillSource?: FakeSkillSource;
  /** The catalog's providers of `default.skill-sources/v1`, or `'fail'` for a failing `Get`. Default: none. */
  readonly catalog?: readonly CatalogSource[] | 'fail';
  /** `hooks/v1.Define`: a throw refuses it. */
  readonly define?: () => void;
  /** `hooks/v1.Run`: the transformed system, or `undefined` for no output; a throw fails it. */
  readonly beforeModelRequest?: (system: string) => string | undefined;
  /** `models/v1.Resolve`: a throw fails it. Default: fails `model_unavailable` for an unconfigured provider. */
  readonly resolve?: (request: {
    readonly providerId: string;
    readonly model: string;
    readonly effort?: string;
  }) => void;
  /** Default: always `harnessNow`. */
  readonly now?: () => Date;
  /** Default: none (`[]`), as the kernel harness. */
  readonly builtInAgents?: readonly AgentFile[];
  /** Default: the real files under {@link bundleRoot}; `'context'` leaves `readAsset` out (`context.assets`). */
  readonly readAsset?: ((path: string) => Promise<Uint8Array>) | 'context';
  /** The bundle directory the router gives `context.assets`. */
  readonly bundleDir?: string;
}

/** The in-memory `executor.session/v1` state, as the runtime would hold it. */
export interface SessionState {
  format: string | undefined;
  readonly parts: Record<string, unknown>;
  /** Every `Record`, decoded, in order. */
  readonly records: RecordedWrite[];
  /** The steers the next `TakeSteers` answers (and removes). */
  readonly steering: SteerInput[];
  readonly attachments: Map<string, Attachment>;
  /** Answers every later `Record` with this failure while set. */
  recordFailure: ContractError | undefined;
  /** Runs for each recorded event, after it was stored. */
  onEvent: (event: unknown) => void;
  /** S51e: every `WatchCancel` received, in order, with its handler signal and the items it yielded. */
  readonly watches: {
    readonly sessionId: string;
    readonly signal: AbortSignal;
    items: number;
  }[];
  /**
   * S51e: cancels session `id` — by default the session of the latest {@link Routed.run}, else
   * {@link sessionId} — as runtime does: every `WatchCancel` of it, open or later, yields its item. Resolves once
   * one yielded it; rejects when none did within 5 s.
   */
  cancel(id?: string): Promise<void>;
  /** Holds every `ReadHistory` until it resolves, while set. */
  readHold: Promise<void> | undefined;
}

export interface Routed {
  readonly router: TestRouter;
  /** Every call a fake received, in order. */
  readonly calls: FakeCall[];
  readonly session: SessionState;
  /** The messages of every `models/v1.Stream`/`Complete`, as the wire carried them. */
  readonly wireMessages: WireMessage[][];
  /** The handler signal of every `models/v1.Stream`/`Complete`. */
  readonly modelSignals: AbortSignal[];
  /** S51e: the handler signal of every `tools/v1.Check` and `Execute`, in order. */
  readonly toolSignals: {
    readonly method: 'check' | 'execute';
    readonly name: string;
    readonly signal: AbortSignal;
  }[];
  readonly executor: Client<typeof ExecutorService>;
  readonly agents: Client<typeof AgentsService>;
  /** Builds `createDefaultHost` and activates it as `main.ts` does. */
  activate(): Promise<HostContext>;
  /** Serves the host's implementations without running its `activate`. */
  serveWithoutActivate(): Promise<void>;
  /** One `Run` as runtime's routed executor sends it; answers its `text`. */
  run(prompt: string, options?: RunOptions): Promise<string>;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly source?: InputSource;
  readonly sessionId?: string;
  readonly thread?: ThreadOverrides;
}

/** The Thread fields a run may vary (its stored execution). */
export interface ThreadOverrides {
  readonly providerId?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** `default`'s host part on a test router with the fakes of {@link SECTION_D}, not yet activated. */
export const routed = (options: RoutedOptions): Routed => {
  const configuration = options.configuration ?? testConfiguration();
  const calls: FakeCall[] = [];
  const wireMessages: WireMessage[][] = [];
  const modelSignals: AbortSignal[] = [];
  const toolSignals: Routed['toolSignals'] = [];
  let running = false;
  const enter = (
    service: { readonly typeName: string },
    method: string,
    context: HandlerContext,
    request: unknown,
  ) => {
    const call = callOf(context);

    calls.push({
      service: service.typeName,
      method,
      request,
      scope: call.scope,
      caller: call.caller?.bundleId,
      running,
    });
  };
  let currentSession = sessionId;
  const { session, entry: sessionEntry } = sessionFake(
    enter,
    () => currentSession,
  );
  const host = {
    current: undefined as ReturnType<typeof createDefaultHost> | undefined,
  };
  const catalog = options.catalog ?? [];

  const router = createTestRouter({
    scope,
    requires: SECTION_D,
    instance: { bundleId: 'default' },
    ...(options.bundleDir === undefined
      ? {}
      : { bundleDir: options.bundleDir }),
    fakes: [
      sessionEntry,
      modelsFake(
        options,
        configuration,
        session,
        enter,
        wireMessages,
        modelSignals,
      ),
      toolsFake(options, enter, toolSignals),
      hooksFake(options, enter),
      hostConfigFake(configuration, enter),
      skillsFake(options, enter),
      catalogFake(catalog, enter),
      ...(options.lease === undefined ? [] : [leaseFake(options.lease, enter)]),
      ...(options.workspace === undefined
        ? []
        : [workspaceFake(options.workspace, enter)]),
      ...(options.skillSource === undefined
        ? []
        : [skillSourceFake(options.skillSource, enter)]),
    ],
  });

  const hostOf = () => {
    host.current ??= createDefaultHost({
      now: options.now ?? (() => new Date(harnessNow)),
      builtInAgents: options.builtInAgents ?? [],
      ...(options.readAsset === 'context'
        ? {}
        : {
            readAsset:
              options.readAsset ??
              (async (path: string) =>
                new Uint8Array(await readFile(join(bundleRoot, path)))),
          }),
    });
    return host.current;
  };
  const executor = router.client(ExecutorService);

  return {
    router,
    calls,
    session,
    wireMessages,
    modelSignals,
    toolSignals,
    executor,
    agents: router.client(AgentsService),
    activate: () => {
      const { implementations, activate } = hostOf();
      return router.activate({
        services: [
          [ExecutorService, implementations.executor],
          [AgentsService, implementations.agents],
        ],
        activate,
      });
    },
    serveWithoutActivate: async () => {
      const { implementations } = hostOf();
      await router.activate({
        services: [
          [ExecutorService, implementations.executor],
          [AgentsService, implementations.agents],
        ],
        activate: () => undefined,
      });
    },
    run: async (prompt, run = {}) => {
      running = true;
      currentSession = run.sessionId ?? sessionId;
      try {
        const { text } = await executor.run(
          {
            sessionId: run.sessionId ?? sessionId,
            thread: wireThread(run.thread),
            job: {
              id: promptId,
              prompt,
              source: wireSource(run.source ?? { kind: 'user' }),
            },
          },
          run.signal === undefined ? {} : { signal: run.signal },
        );
        return text;
      } finally {
        running = false;
      }
    },
  };
};
