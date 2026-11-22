// The health checks of an active instance's control stream (spec
// `docs/designs/grpc-processes.md`, section 5, step 4, and section 7,
// "Health and a stalled host").

import type { Timings } from '../supervisor/timings.js';
import type { RouterDiagnostics } from './control.js';
import type { InstanceKey } from './instances.js';

interface PendingCheck {
  readonly sentAt: number;
  readonly timer: NodeJS.Timeout;
}

/**
 * Sends a `HealthCheck` at every health interval once started, until
 * stopped. A reply records its latency; a check unanswered within the health
 * timeout calls `timedOut`, unless its timer fired more than the stall
 * threshold late: then the host stalled, and a new check is sent. The
 * timeout is decided in a `setImmediate` after the timer, once the event
 * loop has read what the sockets hold, so a reply that arrived while the
 * host was blocked counts.
 */
export class HealthChecks {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly checks = new Map<bigint, PendingCheck>();
  private readonly decisions = new Set<NodeJS.Immediate>();
  private nextNonce = 1n;

  constructor(
    private readonly key: InstanceKey,
    private readonly timings: Timings,
    private readonly diagnostics: RouterDiagnostics,
    private readonly send: (nonce: bigint) => void,
    private readonly timedOut: (message: string) => void,
  ) {}

  /** Starts the checks; does nothing when started or stopped. */
  start(): void {
    if (this.timer !== undefined || this.stopped) {
      return;
    }

    this.timer = setInterval(() => this.check(), this.timings.healthIntervalMs);
  }

  /** The instance's `HealthReply`; an unknown nonce is ignored. */
  reply(nonce: bigint): void {
    const check = this.checks.get(nonce);

    if (check === undefined) {
      return;
    }

    clearTimeout(check.timer);
    this.checks.delete(nonce);
    this.diagnostics.health(this.key, Date.now() - check.sentAt);
  }

  /** Stops every timer for good. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);

    for (const check of this.checks.values()) {
      clearTimeout(check.timer);
    }

    for (const decision of this.decisions) {
      clearImmediate(decision);
    }

    this.checks.clear();
    this.decisions.clear();
  }

  private check(): void {
    const { healthTimeoutMs } = this.timings;
    const nonce = this.nextNonce++;
    const due = Date.now() + healthTimeoutMs;

    this.checks.set(nonce, {
      sentAt: Date.now(),
      timer: setTimeout(() => this.checkTimedOut(nonce, due), healthTimeoutMs),
    });
    this.send(nonce);
  }

  private checkTimedOut(nonce: bigint, due: number): void {
    const delayMs = Date.now() - due;
    const decision = setImmediate(() => {
      this.decisions.delete(decision);
      this.decide(nonce, delayMs);
    });

    this.decisions.add(decision);
  }

  private decide(nonce: bigint, delayMs: number): void {
    if (this.stopped || !this.checks.delete(nonce)) {
      return;
    }

    if (delayMs > this.timings.stallThresholdMs) {
      this.diagnostics.hostStalled(this.key, delayMs);
      this.check();

      return;
    }

    this.timedOut(
      `health_timeout: no HealthReply within ${this.timings.healthTimeoutMs} ms.`,
    );
  }
}
