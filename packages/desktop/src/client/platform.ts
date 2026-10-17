// The window's local platform providers: doric.catalog|bundle|log|diagnostics
// (shared with the other environments) and doric.tokens/v1.

import type {
  DiagnosticReport,
  LogRecord,
  QuarantineReason,
} from 'bundle/contracts';
import {
  catalogSnapshot,
  DiagnosticsStore,
  PLATFORM_VERSION,
  type Principal,
  providePlatformServices,
  type ResolvedEnvironment,
} from 'bundle/runtime';
import { z } from 'zod';

import { shellNotify } from './bridge.js';
import type { DoricDesktopApi } from './protocol.js';

/**
 * The window's diagnostics: kept locally for `doric.diagnostics/v1` and
 * forwarded fire-and-forget to main with `doric.shell/v1.diagnostic`, so main
 * reports quarantines and handler failures to the host.
 */
export class WindowDiagnostics extends DiagnosticsStore {
  readonly #desktop: DoricDesktopApi;

  constructor(options: {
    readonly generation: number;
    readonly desktop: DoricDesktopApi;
    readonly now?: () => number;
  }) {
    super({
      generation: options.generation,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#desktop = options.desktop;
  }

  override quarantine(id: string, reason: QuarantineReason): void {
    super.quarantine(id, reason);
    shellNotify(this.#desktop, 'diagnostic', {
      kind: 'quarantine',
      bundleId: id,
      reason: { code: reason.code, message: reason.message },
    });
  }

  override report(entry: DiagnosticReport): void {
    super.report(entry);
    shellNotify(this.#desktop, 'diagnostic', {
      kind: 'report',
      entry: {
        bundleId: entry.bundleId,
        kind: entry.kind,
        message: entry.message,
        ...(entry.details === undefined ? {} : { details: entry.details }),
      },
    });
  }

  override enterRecovery(reason: string): void {
    super.enterRecovery(reason);
    shellNotify(this.#desktop, 'diagnostic', { kind: 'recovery', reason });
  }
}

const tokensMethods = Object.freeze({
  get: Object.freeze({
    input: z.tuple([]),
    output: z.record(z.string(), z.string()),
  }),
});

/** Registers the window's platform providers under principal `doric`. */
export const provideClientPlatform = (
  platform: Principal,
  options: {
    readonly resolved: ResolvedEnvironment;
    readonly diagnostics: DiagnosticsStore;
    readonly desktop: DoricDesktopApi;
    readonly tokens: Readonly<Record<string, string>>;
  },
): void => {
  const { resolved, diagnostics, desktop } = options;

  providePlatformServices(platform, {
    snapshot: () => catalogSnapshot(resolved, diagnostics),
    diagnostics,
    sink: {
      write: (record: LogRecord) => shellNotify(desktop, 'log', record),
    },
  });

  const tokens = Object.freeze({ ...options.tokens });

  platform.runtime.directory.register(
    Object.freeze({
      contractId: 'doric.tokens/v1',
      bundleId: platform.bundleId,
      version: PLATFORM_VERSION,
      contractVersion: PLATFORM_VERSION,
      environment: 'client' as const,
      cardinality: 'one' as const,
      methods: tokensMethods,
      invoke: async () => ({ ...tokens }),
    }),
  );
};
