// The harness of `files`' host part through the router (phase 3, slices
// S53a and S53b): `files/v1` and the seven workspace tools served from
// `FilesService` and `ToolHandlerService` by `createTestRouter` as
// `src/host/main.ts` serves them (`createFilesHost()`, its `files`,
// `tools.implementation` and `activate`), with recording fakes of
// section D's services: `tools/v1` (`Register`), `runtime.workspace/v1`
// (over `fakeHost().workspace`), `runtime.lease/v1` (over a sandbox of the
// kernel tests, with a settable lease state and sandbox id) and
// `runtime.attachments/v1` (sniffs the image, ids it as sha256, refuses over
// 5 MiB with runtime's message). `core`'s calls to the handler service
// arrive through `router.client` with the caller `core` and the prompt scope;
// `files/v1` calls arrive under the scope a test names.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import hostPath, { posix as sandboxPath } from 'node:path';

import {
  type DescMessage,
  type DescService,
  type JsonValue,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import type { Client, HandlerContext, ServiceImpl } from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  ContractError,
  callOf,
} from 'bundle/contracts';
import {
  RegisterRequestSchema,
  ToolHandlerService,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import type { Host } from 'runtime/contracts';
import { sniffImageMediaType } from 'runtime/contracts';
import { AttachmentsService } from 'runtime/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import {
  DescribeRequestSchema,
  ExecRequestSchema,
  LeaseService,
  ReadFileBytesRequestSchema,
  ReadFileRequestSchema,
  WriteFileRequestSchema,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  CwdRequestSchema,
  LocationRequestSchema,
  SetCwdRequestSchema,
  WorkspaceService,
} from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';

import { FilesService } from '../../src/contracts/gen/doric/files/v1/files_pb.js';
import { createFilesHost } from '../../src/host/service.js';
import { createFakeSandbox, WORKSPACE_ROOT } from '../fake-sandbox.js';
import type { LeasedSandbox } from './services.js';

/** `core`, as the router stamps it on its calls to the handler service. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

/** The scope of the `tools/v1.Execute` call `core` relays: one prompt. */
export const promptScope: CallScope = {
  projectId: 'project-1',
  threadId: 'thread-1',
  promptId: 'prompt-1',
};

/** The services `files`' host part declares it calls (section D). */
export const REQUIRES = [
  ToolsService.typeName,
  WorkspaceService.typeName,
  LeaseService.typeName,
  AttachmentsService.typeName,
];

/** One MiB: the chunk size of `ReadFileBytes` and of `Attach`. */
export const MIB = 1024 * 1024;

/** Runtime's refusal of an attachment over 5 MiB. */
export const OVERSIZE_MESSAGE = 'An attachment is at most 5242880 bytes.';

/** One call a fake received. */
export interface FakeCall {
  /** `lease`, `workspace` or `attachments`. */
  readonly service: string;
  /** The method, lowerCamel (`describe`, `exec`, `setCwd`, `attach`). */
  readonly method: string;
  /** The request as JSON, implicit fields emitted (`attach`: the head). */
  readonly request: JsonValue;
  /** `callOf(context).scope` of the call. */
  readonly scope: CallScope | undefined;
}

/** What the `runtime.lease/v1` fake answers, settable while a test runs. */
export interface LeaseState {
  /** The described sandbox's id; a later `expectSandboxId` must match it. */
  sandboxId: string;
  /** `ready`, or a non-ready status every call then fails with. */
  status: 'ready' | 'pending' | 'unavailable' | 'expired' | 'missing';
  /** When set, `Describe` answers and then the sandbox id becomes this. */
  switchAfterDescribe?: string;
  /** When set, every lease call fails with it (e.g. `thread_control_inactive`). */
  error?: ContractError;
  /** `ReadFileBytes` chunks handed to the stream so far. */
  chunksPulled: number;
  /** `ReadFileBytes` bytes handed to the stream so far. */
  bytesPulled: number;
  /** When set, every `Exec` on a ready lease fails with it (e.g. `internal`). */
  execError?: ContractError;
  /** When set, every `ReadFileBytes` on a ready lease fails with it. */
  readBytesError?: ContractError;
}

/** One `Attach` the fake kept. */
export interface AttachRecord {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface HarnessOptions {
  /** The sandbox behind `runtime.lease/v1`. */
  readonly sandbox: LeasedSandbox;
  /** The Thread behind `runtime.workspace/v1`. */
  readonly host: Host;
  /** `tools/v1.Register` of the tool named so fails with this error. */
  readonly registerError?: {
    readonly name: string;
    readonly error: ContractError;
  };
}

export interface Harness {
  readonly router: TestRouter;
  /** `core`'s client of the bundle's `ToolHandlerService`, under {@link promptScope}. */
  readonly client: Client<typeof ToolHandlerService>;
  /** `tools/v1.Register` requests, as JSON, in order. */
  readonly registers: JsonValue[];
  /** Lease, workspace and attachments calls, in order. */
  readonly calls: FakeCall[];
  /** The lease fake's state. */
  readonly lease: LeaseState;
  /** The attachments the fake kept, in order. */
  readonly attached: AttachRecord[];
  /** Activates the part as `main.ts` does; rejects with what `activate` threw. */
  activate(): Promise<void>;
  /** Serves the part's services as `main.ts` lists them, without its `activate`. */
  serveWithoutActivate(): Promise<void>;
  /** A client of the bundle's `FilesService`, under `scope` (the prompt scope by default). */
  files(scope?: CallScope): Client<typeof FilesService>;
}

/** A `[Service, implementation]` fake that serves only the methods given. */
const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/**
 * A sandbox of the kernel tests over `localRoot` (its `exec`, `readFile`
 * and `getFile`) that also writes files there, so `edit` and `write` run
 * through `exec`-free reads and real writes.
 */
export const diskSandbox = (localRoot: string): LeasedSandbox => {
  const local = (file: string): string =>
    hostPath.join(localRoot, sandboxPath.relative(WORKSPACE_ROOT, file));

  return {
    ...createFakeSandbox(localRoot),
    writeFile: async (file, content) => {
      await mkdir(hostPath.dirname(local(file)), { recursive: true });
      await writeFile(local(file), content, 'utf8');
    },
  };
};

/**
 * `files`' host part on a test router, not yet activated: `services` lists
 * `FilesService` (`host.files`) and `ToolHandlerService`
 * (`host.tools.implementation`), and `activate` is `host.activate`, as
 * `main.ts` does.
 */
export const harness = (options: HarnessOptions): Harness => {
  const { sandbox } = options;
  const registers: JsonValue[] = [];
  const calls: FakeCall[] = [];
  const attached: AttachRecord[] = [];
  const lease: LeaseState = {
    sandboxId: sandbox.id,
    status: 'ready',
    chunksPulled: 0,
    bytesPulled: 0,
  };
  let ids = 0;

  const record = <Desc extends DescMessage>(
    service: string,
    method: string,
    schema: Desc,
    request: MessageShape<Desc>,
    context: HandlerContext,
  ): void => {
    calls.push({
      service,
      method,
      request: toJson(schema, request, { alwaysEmitImplicit: true }),
      scope: callOf(context).scope,
    });
  };

  /** Fails as runtime's lease does for its state and `expectSandboxId`. */
  const check = (target: { expectSandboxId?: string } | undefined): void => {
    if (lease.error !== undefined) throw lease.error;
    if (lease.status !== 'ready') {
      throw new ContractError('unavailable', 'The lease is not ready.', {
        leaseStatus: lease.status,
      });
    }
    if (
      target?.expectSandboxId !== undefined &&
      target.expectSandboxId !== lease.sandboxId
    ) {
      throw new ContractError('unavailable', 'The sandbox changed.', {
        leaseStatus: 'unavailable',
      });
    }
  };

  const leaseFake = fakeOf(LeaseService, {
    describe: (request, context) => {
      record('lease', 'describe', DescribeRequestSchema, request, context);
      check(request.target);
      const answer = { id: lease.sandboxId, root: sandbox.root };

      if (lease.switchAfterDescribe !== undefined) {
        lease.sandboxId = lease.switchAfterDescribe;
      }

      return answer;
    },
    exec: async (request, context) => {
      record('lease', 'exec', ExecRequestSchema, request, context);
      check(request.target);
      if (lease.execError !== undefined) throw lease.execError;
      const input = request.request;
      const result = await sandbox.exec({
        cmd: [...(input?.cmd ?? [])],
        ...(input?.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input?.env.length ? { env: [...input.env] } : {}),
        ...(input?.user === undefined ? {} : { user: input.user }),
        ...(input?.timeoutMs === undefined
          ? {}
          : { timeoutMs: input.timeoutMs }),
      });

      return {
        response: {
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutBytes: result.stdoutBytes ?? Buffer.from(result.stdout),
          stderrBytes: result.stderrBytes ?? Buffer.from(result.stderr),
        },
      };
    },
    readFile: async (request, context) => {
      record('lease', 'readFile', ReadFileRequestSchema, request, context);
      check(request.target);

      return {
        response: {
          content: await sandbox.readFile(request.request?.path ?? ''),
        },
      };
    },
    writeFile: async (request, context) => {
      record('lease', 'writeFile', WriteFileRequestSchema, request, context);
      check(request.target);
      await sandbox.writeFile(
        request.request?.path ?? '',
        request.request?.content ?? '',
      );

      return {};
    },
    readFileBytes: async function* (request, context) {
      record(
        'lease',
        'readFileBytes',
        ReadFileBytesRequestSchema,
        request,
        context,
      );
      check(request.target);
      if (lease.readBytesError !== undefined) throw lease.readBytesError;
      const bytes = await sandbox.getFile(request.request?.path ?? '');

      for (let start = 0; start < bytes.length; start += MIB) {
        const chunk = bytes.subarray(start, start + MIB);

        lease.chunksPulled += 1;
        lease.bytesPulled += chunk.length;
        yield { chunk };
      }
    },
  });

  const workspaceFake = fakeOf(WorkspaceService, {
    cwd: (request, context) => {
      record('workspace', 'cwd', CwdRequestSchema, request, context);

      return { cwd: options.host.workspace.cwd() };
    },
    setCwd: async (request, context) => {
      record('workspace', 'setCwd', SetCwdRequestSchema, request, context);

      return await options.host.workspace.setCwd(request.path);
    },
    location: async (request, context) => {
      record('workspace', 'location', LocationRequestSchema, request, context);

      return await options.host.workspace.location();
    },
  });

  const attachmentsFake = fakeOf(AttachmentsService, {
    attach: async (requests, context) => {
      let name: string | undefined;
      const chunks: Buffer[] = [];
      let size = 0;

      for await (const request of requests) {
        if (request.item.case === 'head') {
          name = request.item.value.name;
          calls.push({
            service: 'attachments',
            method: 'attach',
            request: { name },
            scope: callOf(context).scope,
          });
        } else if (request.item.case === 'chunk') {
          chunks.push(Buffer.from(request.item.value));
          size += request.item.value.length;

          if (size > 5 * MIB) {
            throw new ContractError('invalid_input', OVERSIZE_MESSAGE);
          }
        }
      }

      const bytes = Buffer.concat(chunks);
      const mediaType = sniffImageMediaType(bytes);

      if (name === undefined || mediaType === undefined) {
        throw new ContractError(
          'invalid_input',
          'The attachment is not a PNG, JPEG, WebP or GIF image.',
        );
      }

      const id = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;

      attached.push({ name, bytes });

      return { attachment: { id, name, mediaType, size: bytes.length } };
    },
  });

  const router = createTestRouter({
    caller: core,
    scope: promptScope,
    requires: REQUIRES,
    instance: { bundleId: 'files' },
    fakes: [
      fakeOf(ToolsService, {
        register: (request) => {
          registers.push(toJson(RegisterRequestSchema, request));

          if (request.tool?.name === options.registerError?.name) {
            throw options.registerError?.error;
          }

          ids += 1;

          return { registrationId: `tool-${ids}` };
        },
        unregister: () => ({}),
      }),
      workspaceFake,
      leaseFake,
      attachmentsFake,
    ],
  });

  const serve = async (activateHost: boolean): Promise<void> => {
    const host = createFilesHost();

    await router.activate({
      services: [
        [FilesService, host.files],
        [ToolHandlerService, host.tools.implementation],
      ],
      activate: activateHost ? host.activate : async () => {},
    });
  };

  return {
    router,
    client: router.client(ToolHandlerService),
    registers,
    calls,
    lease,
    attached,
    activate: () => serve(true),
    serveWithoutActivate: () => serve(false),
    files: (scope = promptScope) => router.client(FilesService, { scope }),
  };
};
