/**
 * The footer's git line, stated as the string it renders rather than through the
 * component, so the rule that decides it is covered on its own.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  gitBadgeKind,
  gitDetails,
  gitLine,
  gitStatusLine,
  type Repository,
  type ThreadGit,
} from '../src/domain/thread-git';

type RepositoryOverrides = Partial<Omit<Repository, 'repo'>>;

const repository = (overrides: RepositoryOverrides = {}): ThreadGit => ({
  repo: true,
  root: '/workspace/doric',
  head: 'main',
  detached: false,
  unborn: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  dirty: { staged: 0, modified: 0, untracked: 0 },
  conflicted: 0,
  operation: null,
  worktree: false,
  shallow: false,
  stash: 0,
  submodules: 0,
  ...overrides,
});

describe('git line', () => {
  test('summarizes a clean worktree without repeating its branch', () => {
    const git = repository();
    assert.ok(git.repo);
    assert.equal(gitStatusLine(git), 'Working tree clean');
  });
  test('names a clean branch by its name alone', () => {
    assert.equal(gitLine(repository()), 'main');
  });

  test('names a detached HEAD by its short sha', () => {
    assert.equal(
      gitLine(repository({ head: 'a1b2c3', detached: true })),
      'DETACHED @a1b2c3',
    );
  });

  test('marks an unborn branch on its name', () => {
    assert.equal(gitLine(repository({ unborn: true })), 'main · initial');
  });

  test('shows both tracking counts when the branch tracks an upstream', () => {
    assert.equal(
      gitLine(repository({ upstream: 'origin/main', ahead: 1, behind: 2 })),
      'main · ↑1 ↓2',
    );
  });

  test('shows only the tracking counts that are not zero', () => {
    assert.equal(
      gitLine(repository({ upstream: 'origin/main', ahead: 3 })),
      'main · ↑3',
    );
    assert.equal(
      gitLine(repository({ upstream: 'origin/main', behind: 4 })),
      'main · ↓4',
    );
  });

  test('says nothing about tracking when up to date or untracked', () => {
    assert.equal(gitLine(repository({ upstream: 'origin/main' })), 'main');
    assert.equal(gitLine(repository({ ahead: 2, behind: 1 })), 'main');
  });

  test('carries the non-zero dirty counts in one sign', () => {
    assert.equal(
      gitLine(
        repository({
          dirty: { staged: 2, modified: 1, untracked: 3 },
        }),
      ),
      'main · +2 !1 ?3',
    );
    assert.equal(
      gitLine(repository({ dirty: { staged: 0, modified: 1, untracked: 0 } })),
      'main · !1',
    );
  });

  test('never hides a conflict, carrying its count', () => {
    assert.equal(gitLine(repository({ conflicted: 2 })), 'main · CONFLICT·2');
  });

  test('never hides an operation in progress', () => {
    assert.equal(gitLine(repository({ operation: 'merge' })), 'main · MERGE');
    assert.equal(gitLine(repository({ operation: 'rebase' })), 'main · REBASE');
  });

  test('orders identity, tracking, dirt, then the never-hidden markers', () => {
    assert.equal(
      gitLine(
        repository({
          upstream: 'origin/main',
          ahead: 1,
          behind: 2,
          dirty: { staged: 2, modified: 1, untracked: 3 },
          conflicted: 1,
          operation: 'rebase',
        }),
      ),
      'main · ↑1 ↓2 · +2 !1 ?3 · CONFLICT·1 · REBASE',
    );
  });

  test('says nothing for a working directory that is no repository', () => {
    assert.equal(gitLine({ repo: false }), '');
  });
});

describe('git badge', () => {
  test('leads with the repository whenever the summary says the cwd works in one', () => {
    assert.equal(gitBadgeKind(undefined, undefined), 'conversation');
    assert.equal(gitBadgeKind({ repo: false }, 'git'), 'conversation');
    // A directory inside a repository works in it, even when its own root holds
    // no marker for the host's hint to find: the line is shown either way.
    assert.equal(gitBadgeKind(repository(), undefined), 'git');
    assert.equal(gitBadgeKind(repository(), 'github'), 'github');
  });
});

describe('git details', () => {
  test('name the upstream in full and the stash count', () => {
    const details = gitDetails(
      repository({ upstream: 'origin/main', stash: 2 }),
    );
    assert.deepEqual(
      [
        details.find((detail) => detail.label === 'Upstream')?.value,
        details.find((detail) => detail.label === 'Stashes')?.value,
      ],
      ['origin/main', '2'],
    );
  });

  test('name a shallow clone and a linked worktree only when true', () => {
    const plain = gitDetails(repository());
    assert.equal(
      plain.some((detail) => detail.value === 'shallow'),
      false,
    );
    const special = gitDetails(repository({ shallow: true, worktree: true }));
    assert.equal(
      special.some((detail) => detail.value === 'shallow'),
      true,
    );
    assert.equal(
      special.some((detail) => detail.value === 'linked worktree'),
      true,
    );
  });

  test('name the submodule count only when the repository declares one', () => {
    const plain = gitDetails(repository());
    assert.equal(
      plain.some((detail) => detail.label === 'Submodules'),
      false,
    );
    const declared = gitDetails(repository({ submodules: 3 }));
    assert.equal(
      declared.find((detail) => detail.label === 'Submodules')?.value,
      '3',
    );
  });

  test('answer nothing for a directory that is no repository', () => {
    assert.deepEqual(gitDetails({ repo: false }), []);
  });
});
