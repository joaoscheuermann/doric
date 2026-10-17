import { z } from 'zod';

import type { Call, CallArg } from '../call.js';
import type { Disposable } from '../context.js';
import { type BoundCommand, ref } from '../define.js';
import type { ContractId } from '../ids.js';
import type { Registrable } from '../registrable.js';
import type { AnyServiceRef } from '../types.js';
import { disposableSchema, type MethodSpecs } from './common.js';

/** First provider in stage 8/9 (desktopMain, client). */
export interface Commands {
  register(command: Registrable<BoundCommand>): Disposable;
  execute(
    command: AnyServiceRef | ContractId,
    input?: unknown,
    call?: CallArg,
  ): Promise<void>;
}

export const CommandsV1 = ref<Commands>('commands/v1');

export const isBoundCommand = (value: unknown): value is BoundCommand =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'string' &&
  typeof (value as { execute?: unknown }).execute === 'function';

export const commandsMethods = {
  register: {
    input: z.custom<BoundCommand>(isBoundCommand, {
      message: 'Expected a command bound by its registrant.',
    }),
    output: disposableSchema,
  },
  execute: {
    input: z.tuple([
      z.union([
        z.string(),
        z.object({ kind: z.literal('ref'), id: z.string() }),
      ]),
      z.unknown().optional(),
    ]),
    output: z.void(),
  },
} as const satisfies MethodSpecs;

export type CommandExecute = (input: unknown, call: Call) => Promise<void>;
