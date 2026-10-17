import { z } from 'zod';

import type { CallArg } from '../call.js';
import { ref } from '../define.js';
import type { MethodSpecs } from './common.js';

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Structured log of the calling bundle. The provider fills bundle, version,
 * generation and scope from `call`; a level never throws and is never awaited.
 */
export interface Log {
  debug(message: string, fields?: LogFields, call?: CallArg): void;
  info(message: string, fields?: LogFields, call?: CallArg): void;
  warn(message: string, fields?: LogFields, call?: CallArg): void;
  error(message: string, fields?: LogFields, call?: CallArg): void;
}

export const LogV1 = ref<Log>('log/v1');

const level = {
  input: z.tuple([z.string(), z.record(z.string(), z.unknown()).optional()]),
  output: z.void(),
} as const;

export const logMethods = {
  debug: level,
  info: level,
  warn: level,
  error: level,
} as const satisfies MethodSpecs;
