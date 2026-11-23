// The recording fakes of the services `default`'s host part calls through the
// router (phase 3, slice S51d), but the session and the models (their own modules).

import { create, fromJson, type JsonValue } from '@bufbuild/protobuf';
import {
  anyPack,
  anyUnpack,
  type Value,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import type { HandlerContext } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { CatalogService } from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { ServiceEntry } from 'bundle/host';
import { ConfigurationValueSchema } from 'host-config/contracts/gen/doric/host_config/configuration/v1/configuration_pb.js';
import { HostConfigService } from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import type { ConfigurationValue } from 'runtime/contracts';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { WorkspaceService } from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';

import { OnBeforeModelRequestHookInputSchema } from '../../src/contracts/gen/doric/default/hooks/v1/hooks_pb.js';
import { SkillSourcesService } from '../../src/contracts/gen/doric/default/skill_sources/v1/skill_sources_pb.js';
import type { FakeLease, FakeSkillSource, FakeWorkspace } from './harness.js';
import type { CatalogSource, Routed, RoutedOptions } from './router.js';
import { jsonOf, plain } from './router-wire.js';

/** A `[Service, implementation]` fake serving only the methods given. */
export const fakeOf = (
  service: ServiceEntry[0],
  implementation: object,
): ServiceEntry => [service, implementation] as unknown as ServiceEntry;

/** Records one call a fake received (see `FakeCall`). */
export type Enter = (
  service: { readonly typeName: string },
  method: string,
  context: HandlerContext,
  request: unknown,
) => void;

/** `tools/v1` over `options.tools`, recording each `Check`/`Execute` signal in `toolSignals`. */
export const toolsFake = (
  options: RoutedOptions,
  enter: Enter,
  toolSignals: Routed['toolSignals'],
): ServiceEntry =>
  fakeOf(ToolsService, {
    list: (_request: object, context: HandlerContext) => {
      enter(ToolsService, 'list', context, {});
      return {
        tools: (options.tools ?? []).map((tool) => ({
          bundleId: 'tools-owner',
          alwaysAvailable: false,
          tool: {
            name: tool.name,
            ...(tool.description === undefined
              ? {}
              : { description: tool.description }),
            definition: {
              name: tool.name,
              ...(tool.description === undefined
                ? {}
                : { description: tool.description }),
              inputSchema: JSON.stringify(
                tool.inputSchema ?? {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              ),
              outputSchema: JSON.stringify(tool.outputSchema ?? {}),
            },
            settings: [],
            resultModalities: [...(tool.resultModalities ?? [])],
          },
        })),
      };
    },
    check: (
      request: { name: string; payload?: Value },
      context: HandlerContext,
    ) => {
      const payload = jsonOf(request.payload);
      enter(ToolsService, 'check', context, {
        name: request.name,
        payload,
      });
      toolSignals.push({
        method: 'check',
        name: request.name,
        signal: context.signal,
      });
      const tool = options.tools?.find(({ name }) => name === request.name);
      if (tool === undefined)
        throw new ContractError('not_found', `No tool ${request.name}.`);
      const checked = tool.check?.(payload) ?? {
        success: true as const,
        data: payload,
      };
      return checked.success
        ? { success: true, data: fromJson(ValueSchema, checked.data) }
        : { success: false, issues: [...checked.issues] };
    },
    execute: async (
      request: { name: string; payload?: Value },
      context: HandlerContext,
    ) => {
      const payload = jsonOf(request.payload);
      enter(ToolsService, 'execute', context, {
        name: request.name,
        payload,
      });
      toolSignals.push({
        method: 'execute',
        name: request.name,
        signal: context.signal,
      });
      const tool = options.tools?.find(({ name }) => name === request.name);
      if (tool === undefined)
        throw new ContractError('not_found', `No tool ${request.name}.`);
      const result =
        tool.execute === undefined
          ? {}
          : await tool.execute(payload, context.signal);
      return result === undefined
        ? {}
        : { result: fromJson(ValueSchema, result) };
    },
  });

/** `hooks/v1` over `options.define` and `options.beforeModelRequest`. */
export const hooksFake = (options: RoutedOptions, enter: Enter): ServiceEntry =>
  fakeOf(HooksService, {
    define: (request: { contract: string }, context: HandlerContext) => {
      enter(HooksService, 'define', context, {
        contract: request.contract,
      });
      options.define?.();
      return { registrationId: 'default-hooks' };
    },
    run: (
      request: {
        contract: string;
        hook: string;
        input?: Parameters<typeof anyUnpack>[0];
      },
      context: HandlerContext,
    ) => {
      const input =
        request.input === undefined
          ? undefined
          : anyUnpack(request.input, OnBeforeModelRequestHookInputSchema);
      enter(HooksService, 'run', context, {
        contract: request.contract,
        hook: request.hook,
        system: input?.system,
      });
      const output = options.beforeModelRequest?.(input?.system ?? '');
      return output === undefined
        ? {}
        : {
            output: anyPack(
              OnBeforeModelRequestHookInputSchema,
              create(OnBeforeModelRequestHookInputSchema, {
                system: output,
              }),
            ),
          };
    },
  });

/** `host-config/v1` answering `configuration`. */
export const hostConfigFake = (
  configuration: ConfigurationValue,
  enter: Enter,
): ServiceEntry =>
  fakeOf(HostConfigService, {
    current: (_request: object, context: HandlerContext) => {
      enter(HostConfigService, 'current', context, {});
      return {
        doricConfiguration: {
          configuration: fromJson(
            ConfigurationValueSchema,
            plain(configuration) as JsonValue,
          ),
          revision: 1,
          updatedAt: new Date(0).toISOString(),
        },
      };
    },
  });

/** `skills/v1` over `options.skills`. */
export const skillsFake = (
  options: RoutedOptions,
  enter: Enter,
): ServiceEntry =>
  fakeOf(SkillsService, {
    list: (_request: object, context: HandlerContext) => {
      enter(SkillsService, 'list', context, {});
      return {
        skills: (options.skills ?? []).map(
          ({ alwaysAvailable = true, ...skill }) => ({
            bundleId: 'test',
            alwaysAvailable,
            skill: { ...skill, allowedTools: [...skill.allowedTools] },
          }),
        ),
      };
    },
  });

/** `doric.catalog/v1` listing `catalog` as the providers of `default.skill-sources/v1`. */
export const catalogFake = (
  catalog: readonly CatalogSource[] | 'fail',
  enter: Enter,
): ServiceEntry =>
  fakeOf(CatalogService, {
    get: (_request: object, context: HandlerContext) => {
      enter(CatalogService, 'get', context, {});
      if (catalog === 'fail')
        throw new ContractError('unavailable', 'The catalog is down.');
      return {
        catalogSnapshot: {
          generation: 1,
          composition: { core: 'core' },
          bundles: catalog.map(({ bundleId, state }) => ({
            id: bundleId,
            version: '1.0.0',
            state,
          })),
          contracts: [
            {
              id: 'default.skill-sources/v1',
              environment: 'host',
              cardinality: 'many',
              providers: catalog.map(({ bundleId }) => ({
                bundleId,
                version: '1.0.0',
                bundleVersion: '1.0.0',
              })),
            },
          ],
        },
      };
    },
  });

/** `runtime.workspace/v1` over a kernel-harness `FakeWorkspace`. */
export const workspaceFake = (
  workspace: FakeWorkspace,
  enter: Enter,
): ServiceEntry =>
  fakeOf(WorkspaceService, {
    cwd: async (_request: object, context: HandlerContext) => {
      enter(WorkspaceService, 'cwd', context, {});
      return { cwd: await workspace.cwd() };
    },
  });

/** `runtime.lease/v1` over a kernel-harness `FakeLease`. */
export const leaseFake = (lease: FakeLease, enter: Enter): ServiceEntry =>
  fakeOf(LeaseService, {
    describe: async (_request: object, context: HandlerContext) => {
      enter(LeaseService, 'describe', context, {});
      if (lease.describe === undefined)
        throw new Error('The lease cannot be described.');
      return await lease.describe();
    },
    exec: async (
      request: {
        request?: {
          cmd: string[];
          cwd?: string;
          env: string[];
          timeoutMs?: number;
        };
      },
      context: HandlerContext,
    ) => {
      const input = {
        cmd: [...(request.request?.cmd ?? [])],
        ...(request.request?.cwd === undefined
          ? {}
          : { cwd: request.request.cwd }),
        ...(request.request?.timeoutMs === undefined
          ? {}
          : { timeoutMs: request.request.timeoutMs }),
      };
      enter(LeaseService, 'exec', context, input);
      const result = (await lease.exec?.(input)) ?? {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
      return {
        response: {
          ...(result.exitCode === null || result.exitCode === undefined
            ? {}
            : { exitCode: result.exitCode }),
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    },
    readFile: async (
      request: { request?: { path: string } },
      context: HandlerContext,
    ) => {
      const path = request.request?.path ?? '';
      enter(LeaseService, 'readFile', context, { path });
      if (lease.readFile === undefined)
        throw new Error(`No such file: ${path}`);
      return { response: { content: await lease.readFile(path) } };
    },
  });

/** `default.skill-sources/v1` over a kernel-harness `FakeSkillSource`. */
export const skillSourceFake = (
  source: FakeSkillSource,
  enter: Enter,
): ServiceEntry =>
  fakeOf(SkillSourcesService, {
    list: async (request: { cwd: string }, context: HandlerContext) => {
      enter(SkillSourcesService, 'list', context, { cwd: request.cwd });
      const answer = ((await source.list?.({ cwd: request.cwd })) ?? {
        skills: [],
      }) as { skills: unknown[] };
      return { skills: answer.skills };
    },
    read: async (request: { reference: string }, context: HandlerContext) => {
      enter(SkillSourcesService, 'read', context, {
        reference: request.reference,
      });
      if (source.read === undefined)
        throw new Error(`The skill ${request.reference} cannot be read.`);
      return await source.read({ reference: request.reference });
    },
  });
