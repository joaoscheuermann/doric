// Main's platform providers for the desktopMain generations (section 13.4).
// Each is a `doric.*` service of main's `doric` principal; the generation
// reaches it over its link, whose kernel side sets `call.caller.generation`
// to the generation of that process. Inputs are validated with the
// platform's zod specs when the call is dispatched to the record.

import {
  type Call,
  DoricCacheV1,
  DoricLogV1,
  DoricMenusV1,
  DoricMigrationsV1,
  DoricNotificationsV1,
  DoricTokensV1,
  DoricWindowsV1,
  defineMethod,
  type LogRecord,
  type MenuSkeleton,
  type MigrationResult,
  type NotificationRequest,
  type OpenWindowRequest,
} from 'bundle/contracts';
import {
  definePlatformService,
  type Principal,
  platformContracts,
} from 'bundle/runtime';

import type { PlatformLog } from '../log';
import type {
  KeybindingRequest,
  MenuItemRequest,
  NativeMenus,
} from '../menus/native-menus';
import type { NativeWindows } from '../windows/native-windows';

export interface BrokerDeps {
  readonly windows: Pick<
    NativeWindows,
    'open' | 'focusOrOpen' | 'lastPath' | 'focus' | 'navigate' | 'capture'
  >;
  readonly menus: Pick<
    NativeMenus,
    'setSkeleton' | 'add' | 'addKeybinding' | 'setContext'
  >;
  readonly cacheDirectory: (bundleId: string) => Promise<string>;
  /** The one-time storage copy `doric.migrations/v1.storage` asks for. */
  readonly migrateStorage: (request: {
    readonly key: string;
    readonly marker: string;
  }) => Promise<MigrationResult>;
  readonly tokens: () => Readonly<Record<string, string>>;
  readonly notify: (request: NotificationRequest) => void;
  readonly log: PlatformLog;
}

const specs = platformContracts;

const generationOf = (call: Call): number => call.caller.generation;

/** A synchronous native operation as the promise its contract returns. */
const settled = (run: () => unknown): Promise<void> => {
  try {
    run();

    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
};

/** Registers main's platform providers on its `doric` principal. */
export const provideBroker = (platform: Principal, deps: BrokerDeps): void => {
  const { services } = platform;
  const windows = specs['doric.windows/v1'].methods;
  const menus = specs['doric.menus/v1'].methods;
  const cache = specs['doric.cache/v1'].methods;
  const tokens = specs['doric.tokens/v1'].methods;
  const migrations = specs['doric.migrations/v1'].methods;
  const notifications = specs['doric.notifications/v1'].methods;
  const log = specs['doric.log/v1'].methods;

  services.provide(
    definePlatformService(DoricWindowsV1, {
      open: defineMethod({
        input: windows.open.input,
        output: windows.open.output,
        execute: (request: OpenWindowRequest) => deps.windows.open(request),
      }),
      focusOrOpen: defineMethod({
        input: windows.focusOrOpen.input,
        output: windows.focusOrOpen.output,
        execute: (key: string) => deps.windows.focusOrOpen(key),
      }),
      lastPath: defineMethod({
        input: windows.lastPath.input,
        output: windows.lastPath.output,
        execute: (key: string) => Promise.resolve(deps.windows.lastPath(key)),
      }),
      focus: defineMethod({
        input: windows.focus.input,
        output: windows.focus.output,
        execute: (key: string) => Promise.resolve(deps.windows.focus(key)),
      }),
      navigate: defineMethod({
        input: windows.navigate.input,
        output: windows.navigate.output,
        execute: (input: { key: string; path: string }) =>
          deps.windows.navigate(input),
      }),
      capture: defineMethod({
        input: windows.capture.input,
        output: windows.capture.output,
        execute: (input: Parameters<BrokerDeps['windows']['capture']>[0]) =>
          deps.windows.capture(input),
      }),
    }),
  );
  services.provide(
    definePlatformService(DoricMenusV1, {
      setSkeleton: defineMethod({
        input: menus.setSkeleton.input,
        output: menus.setSkeleton.output,
        execute: (skeleton: MenuSkeleton, call) =>
          settled(() => deps.menus.setSkeleton(generationOf(call), skeleton)),
      }),
      add: defineMethod({
        input: menus.add.input,
        output: menus.add.output,
        execute: (item: MenuItemRequest, call) =>
          settled(() => deps.menus.add(generationOf(call), item)),
      }),
      addKeybinding: defineMethod({
        input: menus.addKeybinding.input,
        output: menus.addKeybinding.output,
        execute: (binding: KeybindingRequest, call) =>
          settled(() => deps.menus.addKeybinding(generationOf(call), binding)),
      }),
      setContext: defineMethod({
        input: menus.setContext.input,
        output: menus.setContext.output,
        execute: (entry: {
          readonly windowKey: string;
          readonly key: 'path' | 'focus';
          readonly value: string | null;
        }) =>
          settled(() =>
            deps.menus.setContext(entry.windowKey, entry.key, entry.value),
          ),
      }),
    }),
  );
  services.provide(
    definePlatformService(DoricCacheV1, {
      directory: defineMethod({
        input: cache.directory.input,
        output: cache.directory.output,
        execute: (_input, call) => deps.cacheDirectory(call.caller.bundleId),
      }),
    }),
  );
  services.provide(
    definePlatformService(DoricMigrationsV1, {
      storage: defineMethod({
        input: migrations.storage.input,
        output: migrations.storage.output,
        execute: (request: { readonly key: string; readonly marker: string }) =>
          deps.migrateStorage(request),
      }),
    }),
  );
  services.provide(
    definePlatformService(DoricTokensV1, {
      get: defineMethod({
        input: tokens.get.input,
        output: tokens.get.output,
        execute: () => Promise.resolve({ ...deps.tokens() }),
      }),
    }),
  );
  services.provide(
    definePlatformService(DoricNotificationsV1, {
      show: defineMethod({
        input: notifications.show.input,
        output: notifications.show.output,
        execute: (request: NotificationRequest) =>
          settled(() => deps.notify(request)),
      }),
    }),
  );
  services.provide(
    definePlatformService(DoricLogV1, {
      write: defineMethod({
        input: log.write.input,
        output: log.write.output,
        execute: (record: LogRecord) => {
          const level = record.level === 'debug' ? 'info' : record.level;

          deps.log[level](
            {
              bundleId: record.bundleId,
              version: record.version,
              generation: record.generation,
              environment: record.environment,
              ...(record.scope === undefined ? {} : { scope: record.scope }),
              ...(record.traceId === undefined
                ? {}
                : { traceId: record.traceId }),
              ...(record.fields ?? {}),
            },
            record.message,
          );
        },
      }),
    }),
  );
};
