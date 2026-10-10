import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

import {
  type Terminal,
  type TerminalSnapshot,
  terminalRecordSchema,
  terminalSnapshotSchema,
} from './model.js';

/*
 * runtime.terminals/v1: the manual terminal sessions of WorkspaceService.
 * terminals (design 57 §2.6). API mínima, provisional until stage 10 moves the
 * registry into the `terminal` bundle.
 */

export interface RuntimeTerminals {
  list(projectId: string, call?: CallArg): Promise<readonly Terminal[]>;
  create(
    input: {
      readonly threadId: string;
      readonly cols?: number;
      readonly rows?: number;
    },
    call?: CallArg,
  ): Promise<Terminal | undefined>;
  snapshot(
    input: { readonly id: string; readonly after?: number },
    call?: CallArg,
  ): Promise<TerminalSnapshot | undefined>;
  input(
    input: { readonly id: string; readonly data: string },
    call?: CallArg,
  ): Promise<boolean>;
  resize(
    input: {
      readonly id: string;
      readonly cols: number;
      readonly rows: number;
    },
    call?: CallArg,
  ): Promise<boolean>;
  stop(id: string, call?: CallArg): Promise<boolean>;
}

export const runtimeTerminalsMethods = {
  list: { input: z.string(), output: z.array(terminalRecordSchema) },
  create: {
    input: z
      .object({
        threadId: z.string(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      })
      .strict(),
    output: terminalRecordSchema.optional(),
  },
  snapshot: {
    input: z.object({ id: z.string(), after: z.number().optional() }).strict(),
    output: terminalSnapshotSchema.optional(),
  },
  input: {
    input: z.object({ id: z.string(), data: z.string() }).strict(),
    output: z.boolean(),
  },
  resize: {
    input: z
      .object({ id: z.string(), cols: z.number(), rows: z.number() })
      .strict(),
    output: z.boolean(),
  },
  stop: { input: z.string(), output: z.boolean() },
} as const;

export const RuntimeTerminalsV1 = ref<RuntimeTerminals>('runtime.terminals/v1');
