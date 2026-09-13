import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';

export const skillsbenchV1_1 = {
  revision: 'b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af',
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const files = async (root, prefix = '') => {
  const result = [];

  for (const entry of (
    await readdir(join(root, prefix), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;

    if (entry.isSymbolicLink()) {
      throw new Error('Symlink in skill package: ' + path);
    }

    if (entry.isDirectory()) {
      result.push(...(await files(root, path)));
    } else if (entry.isFile()) {
      result.push({ path, sha256: sha256(await readFile(join(root, path))) });
    } else {
      throw new Error('Unsupported skill resource: ' + path);
    }
  }

  return result;
};

const readSkill = async (root, source) => {
  let text;

  try {
    text = await readFile(join(root, source, 'SKILL.md'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);

  if (!match) {
    throw new Error('Missing skill frontmatter: ' + source);
  }

  const metadata = parse(match[1]);

  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(metadata.name) ||
    typeof metadata.description !== 'string'
  ) {
    throw new Error('Invalid skill: ' + source);
  }

  const resources = await files(join(root, source));

  return {
    metadata,
    resources,
    hash: sha256(JSON.stringify(resources)),
    body: match[2],
  };
};

/** Hash complete packages, deduplicate identical resources, and keep golds host-side. */
export const scanSkillsbenchCatalog = async ({ root, revision }) => {
  const identities = new Map();
  const tasks = [];

  for (const task of (await readdir(join(root, 'tasks'))).sort()) {
    const goldSkillIds = [];
    const parent = join('tasks', task, 'environment', 'skills');

    for (const entry of (
      await readdir(join(root, parent), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.isSymbolicLink()) {
        throw new Error('Symlink in skill catalog.');
      }

      if (!entry.isDirectory()) {
        continue;
      }

      const source = join(parent, entry.name);
      const value = await readSkill(root, source);

      if (!value) {
        continue;
      }

      const { metadata, resources, hash, body } = value;
      const id = metadata.name + '--' + hash;

      const item = identities.get(id) ?? {
        id,
        skill: {
          name: metadata.name,
          description: metadata.description,
          body,
        },
        files: resources,
        sources: [],
      };

      item.sources.push({ task, path: source });

      identities.set(id, item);

      goldSkillIds.push(id);
    }

    tasks.push({ id: task, goldSkillIds });
  }

  const skills = [...identities.values()].sort((a, b) =>
    a.id.localeCompare(b.id, 'en'),
  );

  const manifest = {
    revision,
    catalogSha256: sha256(
      JSON.stringify(skills.map(({ id, files }) => ({ id, files }))),
    ),
    skills: skills.map(({ skill, ...item }) => ({ ...item, name: skill.name })),
    tasks,
  };

  return { skills, manifest };
};

/** Copy only skill packages; task IDs and gold associations never enter the archive. */
export const materializeSkillsbenchCatalog = async (
  catalog,
  checkout,
  target,
) => {
  await mkdir(target, { recursive: true });

  for (const item of catalog.skills) {
    await cp(join(checkout, item.sources[0].path), join(target, item.id), {
      recursive: true,
    });
  }
};
