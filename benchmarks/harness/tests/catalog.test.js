import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  materializeSkillsbenchCatalog,
  scanSkillsbenchCatalog,
} from '../src/catalog.mjs';

test('catalog preserves resource variants and keeps task provenance outside runtime packages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-catalog-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [task, resource] of [
    ['task-a', 'first'],
    ['task-b', 'first'],
    ['task-c', 'different'],
  ]) {
    const directory = join(root, 'tasks', task, 'environment/skills/shared');

    await mkdir(directory, { recursive: true });

    await writeFile(
      join(directory, 'SKILL.md'),
      '---\nname: shared\ndescription: Shared guide\n---\nUse helper.txt.',
    );

    await writeFile(join(directory, 'helper.txt'), resource);
  }

  const catalog = await scanSkillsbenchCatalog({ root, revision: 'fixture' });

  assert.equal(catalog.skills.length, 2);

  const [a, b, c] = catalog.manifest.tasks;

  assert.deepEqual(a.goldSkillIds, b.goldSkillIds);

  assert.notDeepEqual(a.goldSkillIds, c.goldSkillIds);

  const target = join(root, 'runtime');

  await materializeSkillsbenchCatalog(catalog, root, target);

  assert.equal(
    await readFile(join(target, a.goldSkillIds[0], 'helper.txt'), 'utf8'),
    'first',
  );

  assert.equal(
    await readFile(join(target, c.goldSkillIds[0], 'helper.txt'), 'utf8'),
    'different',
  );

  assert.ok(catalog.skills.every(({ id }) => !id.includes('task-')));
});
