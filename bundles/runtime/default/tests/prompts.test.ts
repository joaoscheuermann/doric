import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { systemPromptWith } from '../src/host/executor.js';
import { sandboxSection } from './support/harness.js';

// Ported from agents/doric/tests/direct-prompts.test.ts.

/**
 * The test target compiles to bundles/runtime/default/dist-tests/tests, so the
 * repository root is five folders above this file, where the bundle skill
 * bodies live.
 */
const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

const readSkill = (path: string): Promise<string> =>
  readFile(join(repositoryRoot, path), 'utf8');

/** The instruction that every Thread's tools resolve relative paths against its cwd. */
const workingDirectoryInstruction =
  /its own working directory[\s\S]*cwd tool[\s\S]*resolve against it/u;

/** A step that moves the Thread's working directory with the `cwd` tool. */
const workingDirectoryStep = /working directory[^.]*`cwd` tool/u;

void test('states the per-thread working directory in the base default prompt', () => {
  assert.match(systemPromptWith(''), workingDirectoryInstruction);
});

void test('keeps the working-directory instruction in the assembled default prompt', () => {
  const prompt = systemPromptWith(sandboxSection);

  assert.match(prompt, workingDirectoryInstruction);
  assert.ok(prompt.includes('Inspect before reporting.'));
});

void test('moves each git skill into the working directory with the cwd tool', async () => {
  const cloning = await readSkill(
    'bundles/features/git/src/skills/git-cloning/SKILL.md',
  );
  const worktrees = await readSkill(
    'bundles/features/git/src/skills/git-worktrees/SKILL.md',
  );

  assert.match(cloning, workingDirectoryStep);
  assert.match(worktrees, workingDirectoryStep);
});
