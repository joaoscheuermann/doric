import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Skill } from 'bundle';

import { directSystemPrompt } from '../src/lib/agents/direct/executor.js';

/**
 * The test target compiles beside the source it tests, so the repository root is
 * four folders above this file, where the bundle skill bodies live.
 */
const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
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

const skill = (name: string, body: string): Skill => ({
  name,
  description: `${name} description`,
  body,
  allowedTools: [],
  indexText: `${name} ${body}`,
});

void test('states the per-thread working directory in the base Direct prompt', () => {
  assert.match(directSystemPrompt([]), workingDirectoryInstruction);
});

void test('keeps the working-directory instruction in the assembled Direct prompt', () => {
  const prompt = directSystemPrompt([
    skill('sandbox', 'Inspect before reporting.'),
  ]);

  assert.match(prompt, workingDirectoryInstruction);
  assert.ok(prompt.includes('Inspect before reporting.'));
});

void test('moves each git skill into the working directory with the cwd tool', async () => {
  const cloning = await readSkill('bundles/git/skills/git-cloning/SKILL.md');
  const worktrees = await readSkill(
    'bundles/git/skills/git-worktrees/SKILL.md',
  );

  assert.match(cloning, workingDirectoryStep);
  assert.match(worktrees, workingDirectoryStep);
});
