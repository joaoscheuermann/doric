import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSkillDocument } from 'bundle';

import { systemPromptWith } from '../src/host/executor.js';
import { harnessVariables, sandboxSection } from './support/harness.js';

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
  assert.match(
    systemPromptWith(harnessVariables, ''),
    workingDirectoryInstruction,
  );
});

void test('keeps the working-directory instruction in the assembled default prompt', () => {
  const prompt = systemPromptWith(harnessVariables, sandboxSection);

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

/** The bullet that sends the model to the cwd tool and its skills before code work. */
const checkWorkingDirectoryBullet =
  '- Before you work on code, check your working directory with the cwd tool. When its result reports a repository root, load the skills that match your work before you start it.';

void test('tells the model to check its working directory and load the matching skills before code work', () => {
  const prompt = systemPromptWith(harnessVariables, '');

  assert.ok(prompt.includes(checkWorkingDirectoryBullet));
  assert.ok(
    prompt.includes(
      "Do not reach into a repository from another directory with working_directory or absolute paths: the repository's own skills and agents are listed from your working directory.",
    ),
  );
  assert.ok(
    !prompt.includes(
      "moving your working directory into it is what gives you the repository's working rules",
    ),
  );
});

void test('ships the coding workflow as a skill to load, ordered first among the built-in skills', async () => {
  const parsed = parseSkillDocument(
    await readSkill(
      'bundles/runtime/default/src/skills/coding-workflow/SKILL.md',
    ),
    'coding-workflow SKILL.md',
    { frontmatterAvailability: true },
  );

  assert.equal(parsed.skill.name, 'coding-workflow');
  assert.equal(parsed.alwaysAvailable, undefined);
  assert.equal(parsed.order, 50);
  assert.ok(
    parsed.skill.body.trimStart().startsWith('# Coding in a repository'),
  );
  assert.ok(!parsed.skill.body.includes('Elephant-Goldfish'));
});
