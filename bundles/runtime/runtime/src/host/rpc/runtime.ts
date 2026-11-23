// `runtime/v2` over the router (phase 3, slice S46a): one handler per RPC,
// each calling today's method (`services/runtime.ts`).

import type { DescMessage, MessageShape } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import type { z } from 'zod';

import {
  AdoptRequestSchema,
  AdoptResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  DeleteProjectResponseSchema,
  DisposeResponseSchema,
  DrainResponseSchema,
  ProjectActivityResponseSchema,
  ProjectResponseSchema,
  ProjectsRequestSchema,
  ProjectsResponseSchema,
  RecoverResponseSchema,
  RecoverWithRequestSchema,
  RecoverWithResponseSchema,
  RenameProjectRequestSchema,
  RenameProjectResponseSchema,
  type RuntimeService,
  SetProjectColorRequestSchema,
  SetProjectColorResponseSchema,
  TerminateProjectResponseSchema,
  VmSshResponseSchema,
  WatchProjectRequestSchema,
  WatchProjectResponseSchema,
  WatchResponseSchema,
} from '../../contracts/gen/doric/runtime/v2/runtime_pb.js';
import { runtimeMethods as methods } from '../../contracts/runtime.js';
import type { RuntimeCore } from '../index.js';
import { decode, encode, runtimeOneofs } from './codec.js';
import { detached, parseInput, routed } from './errors.js';
import { detachedItems } from './streams.js';

/** `value` parsed by today's input schema of `runtime/v2.<method>`. */
const input = <S extends z.ZodType>(
  method: string,
  schema: S,
  value: unknown,
): z.output<S> => parseInput(`runtime/v2 ${method}`, schema, value);

/** The request as today's JSON. */
const json = <D extends DescMessage>(schema: D, request: MessageShape<D>) =>
  decode(schema, request, runtimeOneofs);

/**
 * `runtime/v2` over `RuntimeCore`. `core()` throws
 * `ContractError('unavailable')` before `activate`.
 */
export const routedRuntimeService = (
  core: () => RuntimeCore,
): ServiceImpl<typeof RuntimeService> => {
  /** Runs `work` on the core and encodes its answer as `schema`. */
  const answer = <D extends DescMessage>(
    schema: D,
    work: (runtime: RuntimeCore) => Promise<unknown>,
  ): Promise<MessageShape<D>> =>
    routed(async () =>
      encode(schema, await detached(() => work(core())), runtimeOneofs),
    );

  return {
    recover: () =>
      answer(RecoverResponseSchema, async ({ lifecycle }) => ({
        recoverySummary: await lifecycle.recover(),
      })),
    recoverWith: (request) =>
      answer(RecoverWithResponseSchema, async ({ lifecycle }) => {
        const { handover } = json(RecoverWithRequestSchema, request) as {
          handover?: unknown;
        };
        return {
          recoverySummary: await lifecycle.recoverWith(
            input('recoverWith', methods.recoverWith.input, handover),
          ),
        };
      }),
    adopt: (request) =>
      answer(AdoptResponseSchema, async ({ lifecycle }) => {
        const { handover } = json(AdoptRequestSchema, request) as {
          handover?: unknown;
        };
        await lifecycle.adopt(input('adopt', methods.adopt.input, handover));
        return {};
      }),
    async *drain(_request, context) {
      const { lifecycle } = core();
      for await (const item of detachedItems<{ projectId: string }>((sink) => {
        lifecycle
          .drain((projectId) => sink.next({ projectId }))
          .then(
            () => sink.end(),
            (error: unknown) => sink.end(error),
          );
        return { dispose: () => undefined };
      }, context.signal))
        yield encode(DrainResponseSchema, item, runtimeOneofs);
    },
    dispose: () =>
      answer(DisposeResponseSchema, async ({ lifecycle }) => {
        await lifecycle.dispose();
        return {};
      }),
    createProject: (request) =>
      answer(CreateProjectResponseSchema, async ({ service }) => {
        const { name } = input(
          'createProject',
          methods.createProject.input,
          json(CreateProjectRequestSchema, request),
        );
        return { project: await service.projects.create(name) };
      }),
    project: ({ id }) =>
      answer(ProjectResponseSchema, async ({ service }) => ({
        project: await service.projects.find(
          input('project', methods.project.input, id),
        ),
      })),
    projects: (request) =>
      answer(ProjectsResponseSchema, async ({ service }) => {
        const { limit, cursor } = input(
          'projects',
          methods.projects.input,
          json(ProjectsRequestSchema, request),
        );
        return await service.projects.list(limit, cursor);
      }),
    projectActivity: () =>
      answer(ProjectActivityResponseSchema, async ({ service }) => ({
        projectActivity: await service.projects.activity(),
      })),
    renameProject: (request) =>
      answer(RenameProjectResponseSchema, async ({ service }) => {
        const { id, name } = input(
          'renameProject',
          methods.renameProject.input,
          json(RenameProjectRequestSchema, request),
        );
        return { project: await service.projects.rename(id, name) };
      }),
    setProjectColor: (request) =>
      answer(SetProjectColorResponseSchema, async ({ service }) => {
        const { id, color } = json(SetProjectColorRequestSchema, request) as {
          id?: unknown;
          color?: unknown;
        };
        const parsed = input('setProjectColor', methods.setProjectColor.input, {
          id,
          color: color ?? null,
        });
        return {
          project: await service.projects.setColor(
            parsed.id,
            parsed.color ?? undefined,
          ),
        };
      }),
    terminateProject: ({ id }) =>
      answer(TerminateProjectResponseSchema, async ({ service }) => ({
        project: await service.projects.terminate(
          input('terminateProject', methods.terminateProject.input, id),
        ),
      })),
    deleteProject: ({ id }) =>
      answer(DeleteProjectResponseSchema, async ({ service }) => ({
        deleteResult: await service.projects.delete(
          input('deleteProject', methods.deleteProject.input, id),
        ),
      })),
    vmSsh: ({ vmId }) =>
      answer(VmSshResponseSchema, async ({ service }) => ({
        vmSsh: await service.sshForVm(
          input('vmSsh', methods.vmSsh.input, vmId),
        ),
      })),
    async *watch(_request, context) {
      const { notices } = core();
      for await (const item of detachedItems<unknown>(
        (sink) => notices.watch((notice) => sink.next(notice)),
        context.signal,
      ))
        yield encode(WatchResponseSchema, item, runtimeOneofs);
    },
    async *watchProject(request, context) {
      const { watches } = core();
      const [parsed] = input('watchProject', methods.watchProject.input, [
        json(WatchProjectRequestSchema, request),
        () => undefined,
      ]);
      for await (const item of detachedItems<unknown>(
        (sink) => watches.project(parsed, sink),
        context.signal,
      ))
        yield encode(WatchProjectResponseSchema, item, runtimeOneofs);
    },
  };
};
