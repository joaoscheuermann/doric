// screen.relay/v1: the token tree of every Project screen, served on the origin
// the host already exposes.
//
// This contract belongs to the `screen-relay` bundle because serving it takes
// the host's native listeners, and the platform hands those to a bundle only
// when the composition runs it resident in the kernel process: `register`
// takes a local listener and answers a local cleanup, and neither crosses the
// envelope. The `screen` bundle runs in a generation — that is where
// `runtime.lease/v1.withLease` can hand it a sandbox — so it publishes each
// session's upstream here and mounts nothing itself.

import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

/** Where one screen session's xpra server listens, as the host reaches it. */
export const screenRelayTargetSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().positive().max(65_535),
  })
  .strict();

export type ScreenRelayTarget = z.infer<typeof screenRelayTargetSchema>;

/** One session's upstream, under the token its path carries. */
export const screenRelayExposeSchema = z
  .object({
    token: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive().max(65_535),
  })
  .strict();

export type ScreenRelayExpose = z.infer<typeof screenRelayExposeSchema>;

/** The token to drop. */
export const screenRelayForgetSchema = z
  .object({ token: z.string().min(1) })
  .strict();

export type ScreenRelayForget = z.infer<typeof screenRelayForgetSchema>;

export interface ScreenRelay {
  /** Registers (or replaces) the upstream of one session token. */
  expose(input: ScreenRelayExpose, call?: CallArg): Promise<void>;
  /** Drops a token; its requests answer 404 afterwards. */
  forget(input: ScreenRelayForget, call?: CallArg): Promise<void>;
}

export const screenRelayMethods = {
  expose: { input: screenRelayExposeSchema, output: z.void() },
  forget: { input: screenRelayForgetSchema, output: z.void() },
} as const;

/** screen.relay/v1, as the `screen-relay` bundle provides it. */
export const ScreenRelayV1 = ref<ScreenRelay>('screen.relay/v1');
