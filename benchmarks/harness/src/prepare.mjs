import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadBundles } from 'bundle';

import {
  materializeSkillsbenchCatalog,
  scanSkillsbenchCatalog,
  skillsbenchV1_1,
} from './catalog.mjs';

/** Build a task-neutral skill catalog; gold associations stay on the host. */
export const prepareAssets = async ({ root, checkout, directory, config }) => {
  const catalog = await scanSkillsbenchCatalog({
    root: checkout,
    revision: skillsbenchV1_1.revision,
  });
  const assets = join(directory, 'assets');

  await cp(join(root, 'dist/local'), assets, { recursive: true });

  await materializeSkillsbenchCatalog(
    catalog,
    checkout,
    join(assets, 'catalog'),
  );

  const core = (await loadBundles(join(assets, 'bundles'))).find(
    ({ name }) => name === 'core',
  );

  const skills = catalog.skills.map(({ id, skill }) => ({
    name: id,
    body:
      'Skill resources: /opt/doric/catalog/' +
      id +
      '\nResolve relative resource paths from that directory.\n\n' +
      skill.body,
  }));

  for (const { skill, alwaysAvailable } of core.skills) {
    if (!alwaysAvailable) {
      skills.push({ name: 'core--' + skill.name, body: skill.body });
    }
  }

  await writeFile(join(assets, 'catalog.json'), JSON.stringify(skills));

  await writeFile(join(assets, 'config.json'), JSON.stringify(config));

  await writeFile(
    join(directory, 'catalog-manifest.json'),
    JSON.stringify(catalog.manifest, null, 2),
  );

  return {
    assets,
    catalogHash: catalog.manifest.catalogSha256,
    skills: skills.length,
  };
};

/** Generate manifests referencing this run's local archive, with no published release. */
export const writeManifests = async ({ root, directory, url, archive }) => {
  const bootstrap = await readFile(join(root, 'src/bootstrap.sh'), 'utf8');

  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');

  const install =
    bootstrap +
    '\n' +
    [
      'mkdir -p /opt/doric',
      `curl -fsSLo /opt/doric/agent.tar.gz '${url}/agent.tar.gz'`,
      `printf '%s  %s\\n' '${digest}' /opt/doric/agent.tar.gz | sha256sum -c -`,
      'tar -xzf /opt/doric/agent.tar.gz -C /opt/doric',
      'rm /opt/doric/agent.tar.gz',
    ].join('\n');

  for (const mode of ['direct', 'mosaic']) {
    const target = join(directory, 'agents', 'doric-' + mode);

    await mkdir(target, { recursive: true });

    await writeFile(
      join(target, 'manifest.toml'),
      [
        'contract_version = "1.0"',
        `name = "doric-${mode}"`,
        'protocol = "acp"',
        'api_protocol = "openai-completions"',
        `install_cmd = '''${install}'''`,
        `launch_cmd = "exec /opt/benchflow/node/bin/node /opt/doric/agent.mjs ${mode}"`,
        'supports_acp_set_model = false',
        'skill_paths = []',
        'home_dirs = []',
        '[env_mapping]',
        'BENCHFLOW_PROVIDER_API_KEY = "BENCHFLOW_PROVIDER_API_KEY"',
      ].join('\n') + '\n',
    );
  }

  return digest;
};
