import { z } from 'zod';

import type { Disposable } from '../context.js';
import { ref } from '../define.js';
import {
  disposableSchema,
  functionSchema,
  type MethodSpecs,
} from './common.js';

/** A custom element class; structural because DOM types are not in scope. */
export type ElementConstructor = abstract new (...args: never[]) => object;

/** First provider in stage 9 (client). */
export interface Ui {
  define(tag: string, element: ElementConstructor): Disposable;
  create(tag: string, props?: Readonly<Record<string, unknown>>): object;
  dispose(element: object): void;
}

export const UiV1 = ref<Ui>('ui/v1');

const elementSchema = z.custom<object>(
  (value) =>
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null,
);

export const uiMethods = {
  define: {
    input: z.tuple([z.string(), functionSchema<ElementConstructor>()]),
    output: disposableSchema,
  },
  create: {
    input: z.tuple([z.string(), z.record(z.string(), z.unknown()).optional()]),
    output: elementSchema,
  },
  dispose: { input: elementSchema, output: z.void() },
} as const satisfies MethodSpecs;
