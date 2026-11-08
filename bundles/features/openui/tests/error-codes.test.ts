// B20 (openui.md D18): `OPENUI_ERROR_CODES` is lang-core's `OpenUIErrorCode`
// as a value. The two type assertions below fail the bundle's test build
// (`tsc -p tsconfig.spec.json`) when a lang-core upgrade changes the codes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { OpenUIErrorCode } from '@openuidev/lang-core';

import { OPENUI_ERROR_CODES } from '../src/contracts/index.js';

type Listed = (typeof OPENUI_ERROR_CODES)[number];

/** Compiles only when `A` is assignable to `B`. */
type Assignable<A extends B, B> = A;

// lang-core's codes are all in the list…
export type LangCoreInList = Assignable<OpenUIErrorCode, Listed>;
// …and the list holds no code lang-core lacks.
export type ListInLangCore = Assignable<Listed, OpenUIErrorCode>;

test('the list holds 15 distinct codes', () => {
  assert.equal(OPENUI_ERROR_CODES.length, 15);
  assert.equal(new Set(OPENUI_ERROR_CODES).size, 15);
});
