// A host part's `main.ts` whose behavior the test picks by its arguments:
// `node main.js <mode> [log] [ms] [count]`. `tests/platform/supervisor.test.ts`,
// `crash.test.ts` and `shutdown.test.ts` give each bundle its own arguments
// through `commandOf` (spec `docs/designs/grpc-processes.md`, section 7, A64)
// and read the log, a file of lines `<bundleId> <event> <pid>` appended in
// the order they happen. Every process logs `start`, then
// `as-<generation>.<incarnation>`; an activated one logs `deactivate` and
// `deactivated` around its deactivation.
//
// Modes:
// - `alive`: activates at once;
// - `slow-activate`: activation takes `ms`;
// - `activate-fails`: activation throws `fixture activation failed`;
// - `freeze-after-active`: activates, then blocks its event loop forever;
// - `exit-before-hello`: exits with code 3 before it connects;
// - `never-hello`: never connects, and ignores `SIGTERM`;
// - `delay-hello`: connects `ms` after its start;
// - `wrong-instance`: says Hello with a generation that is not its own;
// - `crash-after-active`: activates, then logs `crash` and exits with code 5
//   `ms` later, while the bundle's processes so far (its `start` lines) are at
//   most `count` (unlimited when `count` is absent);
// - `crash-in-activate`: logs `crash` and exits with code 5 during its
//   activation, while its processes so far are at most `count` (unlimited
//   when absent); otherwise activates at once;
// - `serve-settings`: serves `settings/v1`'s `Register`, which answers
//   `registered <id>`;
// - `crash-in-call`: serves `Register`, which logs `call`, then logs `crash`
//   and exits with code 5 50 ms later without answering;
// - `call-provider`: activates, then calls `settings/v1`'s `Register` and logs
//   `call-ok` or `call-failed:<Doric code>`;
// - `call-in-deactivate`: its deactivation calls `Register` and logs
//   `deactivate-call-ok` or `deactivate-call-failed:<Doric code>`;
// - `ignore-stop`: its deactivation never ends, so it never answers `Stop`;
// - `generations`: logs each `GenerationChanged` as
//   `changed:<event>:<generation>.<incarnation>` of its subject and each
//   `PeerSignal` as `signal:<topic>:<generation>.<incarnation>` of its
//   sender (`generations-unavailable` when `context.generations` throws);
//   when the `activated` frame is about itself and its generation is above
//   1, sends `Signal { topic: "hello" }`. Serves `Register`, which logs
//   `call`, waits `ms`, logs `answered` and answers `g<generation>`, or logs
//   `cancelled` and fails when the call is cancelled first;
// - `hold-on-drain`: as `generations`, and its `draining` handler, for
//   itself, takes a `doric.generation/v1` hold (`held`) before it returns
//   and releases it `ms` later (`released`);
// - `call-repeat`: `count` times (1 when absent), one after the other, waits
//   `ms` and calls `Register`, then logs `call-ok:<registrationId>` or
//   `call-failed:<Doric code>`;
// - `serve-models`: serves `models/v1`'s `Kind`, which logs `call`, waits
//   `ms`, logs `answered` and answers the kind `{ id: <request id>, label:
//   "g<generation>" }`;
// - `http-prefix`: speaks the control protocol itself, since the SDK always
//   reports `httpPort: 0`: serves an HTTP prefix on its own `http.Server`
//   bound to `127.0.0.1:0` and reports its port in the Hello's `httpPort`.
//   A request logs `request`, waits `ms` and answers 200 with the body
//   `g<generation> <method> <url>`; an `upgrade` answers `101`, writes
//   `g<generation>:` and the `head`, then echoes every chunk it reads
//   prefixed with `g<generation>:`. Activates at once, acknowledges every
//   `GenerationChanged`, answers `HealthCheck`, and on `Stop` answers
//   `StopResult`, logs `stopped` and exits 0;
// - `http-server`: answers requests and upgrades as `http-prefix` does, but
//   through `runBundle`'s `httpServer` (the SDK binds it and reports its
//   port);
// - `serve-demo`: serves `demo.v1.DemoService` of `demoFile` (`demo/v1`,
//   `Watch` resumable): `Echo` answers `g<generation>:<text>`; `Watch` logs
//   `watch:<text>`, sends the snapshot `g<generation>:snapshot:<text>` and
//   stays open until the call is cancelled;
// - `watch-demo`: activates, then opens `demo.v1.DemoService`'s `Watch`
//   `{ text: "h" }` through `context.services.use` with the `resume` request
//   `after-<last item's text>`, and logs each item as `item:<text>`, then
//   `watch-ended` or `watch-failed:<Doric code>`;
// - `describe-platform`: activates, then calls, through
//   `context.services.use`, `doric.bundle/v1`'s `Describe`, logging
//   `bundle:<bundleId>:<version>:<generation>:<environment>`;
//   `doric.catalog/v1`'s `Get`, logging `catalog:<generation>:<bundle ids,
//   comma-separated, in order>` and `storage:<hostId>:<storageGeneration>`
//   or `storage:none`; and `doric.diagnostics/v1`'s `Get`, logging
//   `diagnostics:<mode>:<generation>`. A failed call logs
//   `<bundle|catalog|diagnostics>-failed:<Doric code>`; `described` follows
//   the three;
// - `serve-storage-identity`: serves `storage.backend/v1`'s `Identity` only,
//   which logs `identity:<caller bundle id>` and answers the identity
//   `{ hostId: fixtureHostId, storageGeneration: 3 }`;
// - `identity-fails`: serves `Identity` only, which logs
//   `identity:<caller bundle id>` and fails with `limit_exceeded`, message
//   `fixture identity failed`.
//
// Every mode ignores `SIGTERM`, so only `SIGKILL` ends one that does not exit
// by itself.

import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { create, fromJson, type MessageInitShape } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  ConnectError,
  createClient,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';

import { ContractError } from '../../../src/contracts/error.js';
import { ModelsService } from '../../../src/contracts/gen/doric/models/v1/models_pb.js';
import { BundleService } from '../../../src/contracts/gen/doric/platform/bundle/v1/bundle_pb.js';
import { CatalogService } from '../../../src/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import { DiagnosticsService } from '../../../src/contracts/gen/doric/platform/diagnostics/v1/diagnostics_pb.js';
import { GenerationService } from '../../../src/contracts/gen/doric/platform/generation/v1/generation_pb.js';
import {
  BundleHostService,
  type ConnectRequest,
  ConnectRequestSchema,
} from '../../../src/contracts/gen/doric/platform/v1/control_pb.js';
import { SettingsService } from '../../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import { BackendService } from '../../../src/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import { callOf } from '../../../src/contracts/metadata.js';
import { fromConnectError } from '../../../src/contracts/status.js';
import { runBundle } from '../../../src/index.js';
import type { HostContext, ServiceEntry } from '../../../src/sdk/host/index.js';
import {
  type DemoMessage,
  demoFile,
  serviceOf,
} from '../../support/demo-contract.js';

const [mode = 'alive', log, msText, countText] = process.argv.slice(2);
const ms = Number(msText ?? '0');
const count =
  countText === undefined || countText === ''
    ? Number.POSITIVE_INFINITY
    : Number(countText);
const bundleId = process.env.DORIC_BUNDLE_ID ?? 'unknown';

const record = (event: string): void => {
  if (log !== undefined && log !== '') {
    appendFileSync(log, `${bundleId} ${event} ${process.pid}\n`);
  }
};

/** How many processes of this bundle have started, this one included. */
const starts = (): number => {
  if (log === undefined || log === '') {
    return 1;
  }

  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`${bundleId} start `)).length;
};

const sleep = (delay: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delay));

const crash = (): void => {
  record('crash');
  process.exit(5);
};

process.on('SIGTERM', () => {});
record('start');
record(
  `as-${process.env.DORIC_GENERATION ?? '?'}.${process.env.DORIC_INCARNATION ?? '?'}`,
);

const register = { id: 'acme.thing/v1', messageType: 'acme.Thing' };

/** The host id `serve-storage-identity` answers. */
const fixtureHostId = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60';

/** `g<generation>`, the tag of this process's answers. */
const generationTag = `g${process.env.DORIC_GENERATION ?? '?'}`;

/** `demo.v1.DemoService` of `demo/v1`, its `Watch` resumable. */
const DemoService = serviceOf(
  demoFile({ id: 'demo/v1', package: 'demo.v1', resumable: true }),
  'DemoService',
);

/** `settings/v1`'s `Register` from `context`; logs `<prefix>-ok` or the failure. */
const callRegister = async (
  context: HostContext,
  prefix: string,
): Promise<void> => {
  try {
    await context.services.use(SettingsService).register(register);
    record(`${prefix}-ok`);
  } catch (error) {
    const { code } = fromConnectError(ConnectError.from(error));

    record(`${prefix}-failed:${code}`);
  }
};

const settings = (
  implementation: Partial<ServiceImpl<typeof SettingsService>>,
): ServiceEntry =>
  [
    SettingsService,
    implementation as ServiceImpl<typeof SettingsService>,
  ] as ServiceEntry;

/** The handlers of the `generations` and `hold-on-drain` modes. */
function watchGenerations(context: HostContext, hold: boolean): void {
  const self = context.instance;
  const generation = context.services.use(GenerationService);

  try {
    context.generations.onChanged(async (change) => {
      record(
        `changed:${change.event}:${change.generation}.${change.incarnation}`,
      );

      const aboutSelf =
        change.generation === self.generation &&
        change.incarnation === self.incarnation;

      if (hold && aboutSelf && change.event === 'draining') {
        const { holdId } = await generation.hold({ key: 'fixture' });

        record('held');
        setTimeout(() => {
          void generation.release({ holdId }).then(() => record('released'));
        }, ms);
      }

      if (aboutSelf && change.event === 'activated' && self.generation > 1) {
        void generation.signal({
          topic: 'hello',
          payload: fromJson(ValueSchema, { generation: self.generation }),
        });
      }
    });
    context.generations.onSignal((signal) => {
      record(
        `signal:${signal.topic}:${signal.from.generation}.${signal.from.incarnation}`,
      );
    });
  } catch {
    record('generations-unavailable');
  }
}

const run = (
  activate: (context: HostContext) => Promise<void> | void,
  options: {
    readonly services?: readonly ServiceEntry[];
    readonly deactivate?: (context: HostContext) => Promise<void> | void;
    readonly httpServer?: http.Server;
  } = {},
): void => {
  runBundle({
    services: options.services ?? [],
    ...(options.httpServer === undefined
      ? {}
      : { httpServer: options.httpServer }),
    activate: async (context) => {
      record('activate');
      await activate(context);
      record('activated');
    },
    deactivate: async (context) => {
      record('deactivate');
      await options.deactivate?.(context);
      record('deactivated');
    },
  });
};

switch (mode) {
  case 'exit-before-hello':
    process.exit(3);
    break;
  case 'never-hello':
    setInterval(() => {}, 1_000);
    break;
  case 'delay-hello':
    setTimeout(() => run(() => {}), ms);
    break;
  case 'wrong-instance':
    process.env.DORIC_GENERATION = String(
      Number(process.env.DORIC_GENERATION ?? '1') + 98,
    );
    run(() => {});
    break;
  case 'slow-activate':
    run(() => sleep(ms));
    break;
  case 'activate-fails':
    run(() => {
      throw new Error('fixture activation failed');
    });
    break;
  case 'freeze-after-active':
    run(() => {
      setTimeout(() => {
        record('freeze');
        for (;;) {
          // Blocks the event loop: no HealthReply is ever sent again.
        }
      }, 50);
    });
    break;
  case 'crash-after-active':
    run(() => {
      if (starts() <= count) {
        setTimeout(crash, ms);
      }
    });
    break;
  case 'crash-in-activate':
    run(async () => {
      if (starts() <= count) {
        await sleep(ms);
        crash();
      }
    });
    break;
  case 'serve-settings':
    run(() => {}, {
      services: [
        settings({
          register: (request) => ({
            registrationId: `registered ${request.id}`,
          }),
        }),
      ],
    });
    break;
  case 'crash-in-call':
    run(() => {}, {
      services: [
        settings({
          register: async () => {
            record('call');
            await sleep(50);
            crash();

            return { registrationId: 'never' };
          },
        }),
      ],
    });
    break;
  case 'call-provider':
    run((context) => {
      setTimeout(() => void callRegister(context, 'call'), ms);
    });
    break;
  case 'call-in-deactivate':
    run(() => {}, {
      deactivate: (context) => callRegister(context, 'deactivate-call'),
    });
    break;
  case 'ignore-stop':
    run(() => {}, { deactivate: () => new Promise<void>(() => {}) });
    break;
  case 'generations':
  case 'hold-on-drain':
    run((context) => watchGenerations(context, mode === 'hold-on-drain'), {
      services: [
        settings({
          register: async (_request, handler) => {
            record('call');

            const cancelled = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => resolve(false), ms);

              handler.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve(true);
              });
            });

            if (cancelled) {
              record('cancelled');
              throw new Error('cancelled');
            }

            record('answered');

            return {
              registrationId: `g${process.env.DORIC_GENERATION ?? '?'}`,
            };
          },
        }),
      ],
    });
    break;
  case 'call-repeat':
    run((context) => {
      void (async () => {
        const times = Number.isFinite(count) ? count : 1;

        for (let index = 0; index < times; index += 1) {
          await sleep(ms);

          try {
            const { registrationId } = await context.services
              .use(SettingsService)
              .register(register);

            record(`call-ok:${registrationId}`);
          } catch (error) {
            const { code } = fromConnectError(ConnectError.from(error));

            record(`call-failed:${code}`);
          }
        }
      })();
    });
    break;
  case 'serve-models':
    run(() => {}, {
      services: [
        [
          ModelsService,
          {
            kind: async (request: { id: string }) => {
              record('call');
              await sleep(ms);
              record('answered');

              return {
                modelKindDescriptor: {
                  id: request.id,
                  label: `g${process.env.DORIC_GENERATION ?? '?'}`,
                },
              };
            },
          } as unknown as ServiceImpl<typeof ModelsService>,
        ] as ServiceEntry,
      ],
    });
    break;
  case 'http-prefix':
    void servePrefix();
    break;
  case 'http-server':
    run(() => {}, { httpServer: prefixServer() });
    break;
  case 'serve-demo':
    run(() => {}, {
      services: [
        [
          DemoService,
          {
            echo: (request: DemoMessage) => ({
              text: `${generationTag}:${request.text}`,
            }),
            watch: async function* (
              request: DemoMessage,
              handler: { readonly signal: AbortSignal },
            ) {
              record(`watch:${request.text}`);
              yield { text: `${generationTag}:snapshot:${request.text}` };
              await new Promise<void>((resolve) => {
                if (handler.signal.aborted) {
                  resolve();
                }

                handler.signal.addEventListener('abort', () => resolve());
              });
            },
          } as unknown as ServiceImpl<typeof DemoService>,
        ] as ServiceEntry,
      ],
    });
    break;
  case 'watch-demo':
    run((context) => {
      const resume = {
        watch: (last: DemoMessage) => ({ text: `after-${last.text}` }),
      };
      const client = context.services.use(DemoService, {
        resume,
      }) as unknown as {
        watch(request: DemoMessage): AsyncIterable<DemoMessage>;
      };

      void (async () => {
        try {
          for await (const item of client.watch({ text: 'h' })) {
            record(`item:${item.text}`);
          }

          record('watch-ended');
        } catch (error) {
          const { code } = fromConnectError(ConnectError.from(error));

          record(`watch-failed:${code}`);
        }
      })();
    });
    break;
  case 'describe-platform':
    run((context) => {
      void describePlatform(context);
    });
    break;
  case 'serve-storage-identity':
  case 'identity-fails':
    run(() => {}, {
      services: [
        [
          BackendService,
          {
            identity: (_request: unknown, context: HandlerContext) => {
              record(`identity:${callOf(context).caller.bundleId}`);

              if (mode === 'identity-fails') {
                throw new ContractError(
                  'limit_exceeded',
                  'fixture identity failed',
                );
              }

              return {
                storageIdentity: {
                  hostId: fixtureHostId,
                  storageGeneration: 3,
                },
              };
            },
          } as unknown as ServiceImpl<typeof BackendService>,
        ] as ServiceEntry,
      ],
    });
    break;
  default:
    run(() => {});
}

/** The Doric code of a failed call. */
function codeOf(error: unknown): string {
  return fromConnectError(ConnectError.from(error)).code;
}

/** The `describe-platform` mode's calls, after the activation. */
async function describePlatform(context: HostContext): Promise<void> {
  try {
    const described = await context.services.use(BundleService).describe({});

    record(
      `bundle:${described.bundleId}:${described.version}:${described.generation}:${described.environment}`,
    );
  } catch (error) {
    record(`bundle-failed:${codeOf(error)}`);
  }

  try {
    const { catalogSnapshot } = await context.services
      .use(CatalogService)
      .get({});
    const ids = (catalogSnapshot?.bundles ?? []).map(({ id }) => id);
    const storage = catalogSnapshot?.storage;

    record(`catalog:${catalogSnapshot?.generation}:${ids.join(',')}`);
    record(
      storage === undefined
        ? 'storage:none'
        : `storage:${storage.hostId}:${storage.storageGeneration}`,
    );
  } catch (error) {
    record(`catalog-failed:${codeOf(error)}`);
  }

  try {
    const diagnostics = await context.services
      .use(DiagnosticsService)
      .get({});

    record(`diagnostics:${diagnostics.mode}:${diagnostics.generation}`);
  } catch (error) {
    record(`diagnostics-failed:${codeOf(error)}`);
  }

  record('described');
}

/**
 * The HTTP server of the `http-prefix` and `http-server` modes, not yet
 * listening.
 */
function prefixServer(): http.Server {
  const tag = generationTag;
  const server = http.createServer((request, response) => {
    record('request');
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`${tag} ${request.method} ${request.url}`);
    }, ms);
  });

  server.on('upgrade', (_request, socket, head) => {
    record('upgrade');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: fixture\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.write(Buffer.concat([Buffer.from(`${tag}:`), head]));
    socket.on('data', (chunk: Buffer) => {
      socket.write(Buffer.concat([Buffer.from(`${tag}:`), chunk]));
    });
    socket.on('error', () => {});
  });

  return server;
}

/** The `http-prefix` mode: an HTTP prefix and a hand-written control stream. */
async function servePrefix(): Promise<void> {
  const server = prefixServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;
  const queue: ConnectRequest[] = [];
  let wake: (() => void) | undefined;
  const send = (frame: MessageInitShape<typeof ConnectRequestSchema>): void => {
    queue.push(create(ConnectRequestSchema, frame));
    wake?.();
  };
  const outbox = async function* (): AsyncGenerator<ConnectRequest> {
    for (;;) {
      const next = queue.shift();

      if (next !== undefined) {
        yield next;
        continue;
      }

      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  const client = createClient(
    BundleHostService,
    createGrpcTransport({ baseUrl: process.env.DORIC_ROUTER_URL ?? '' }),
  );

  send({
    frame: {
      case: 'hello',
      value: {
        protocolVersion: 1,
        instance: {
          bundleId,
          generation: Number(process.env.DORIC_GENERATION ?? '0'),
          incarnation: Number(process.env.DORIC_INCARNATION ?? '0'),
        },
        services: [],
        httpPort: port,
      },
    },
  });

  try {
    for await (const response of client.connect(outbox(), {
      headers: {
        authorization: `Bearer ${process.env.DORIC_INSTANCE_TOKEN ?? ''}`,
      },
    })) {
      const { frame } = response;

      switch (frame.case) {
        case 'activate':
          record('activate');
          send({ frame: { case: 'activateResult', value: {} } });
          record('activated');
          break;
        case 'healthCheck':
          send({
            frame: {
              case: 'healthReply',
              value: { nonce: frame.value.nonce },
            },
          });
          break;
        case 'generationChanged':
          send({
            frame: {
              case: 'generationAck',
              value: { event: frame.value.event },
            },
          });
          break;
        case 'stop':
          send({ frame: { case: 'stopResult', value: {} } });
          record('stopped');
          setTimeout(() => process.exit(0), 50);
          break;
        default:
          break;
      }
    }
  } catch {
    // The host is gone.
  }

  process.exit(0);
}
