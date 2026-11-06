// H1: every bundle the shipped composition names is staged and compiled in
// every build path of the host: the Nx `build-bundles` stage command and the
// image's `.Dockerfile` (`tsc` and `stage`). A bundle missing from one list
// boots in one build and is absent in another (the image once omitted
// `openui`). `openui` is listed before `papercraft`, which builds on it.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const hostDir = 'app/backend/doric-host';

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

interface ShippedComposition {
  readonly core: string;
  readonly enabled: readonly string[];
  readonly alternatives?: Readonly<
    Record<string, { readonly options: readonly string[] }>
  >;
}

/** Every bundle id the shipped composition names, enabled or alternative. */
const compositionIds = async (): Promise<string[]> => {
  const composition = (await readJson(
    join(hostDir, 'composition.json'),
  )) as unknown as ShippedComposition;

  return [
    ...new Set([
      composition.core,
      ...composition.enabled,
      ...Object.values(composition.alternatives ?? {}).flatMap(
        ({ options }) => options,
      ),
    ]),
  ];
};

/** The repository path (`bundles/<group>/<dir>`) of each bundle, by manifest id. */
const bundlePathsById = async (): Promise<Map<string, string>> => {
  const paths = new Map<string, string>();

  for (const group of await readdir('bundles', { withFileTypes: true })) {
    if (!group.isDirectory()) {
      continue;
    }

    for (const entry of await readdir(join('bundles', group.name), {
      withFileTypes: true,
    })) {
      const dir = `bundles/${group.name}/${entry.name}`;

      try {
        const { id } = await readJson(join(dir, 'manifest.json'));

        paths.set(String(id), dir);
      } catch {
        // Not a bundle directory.
      }
    }
  }

  return paths;
};

/** The arguments after `cli.js stage <destination>`, up to the next `&&`. */
const stagedIn = (command: string): string[] => {
  const match = /cli\.js stage \S+((?:\s+(?!&&)\S+)*)/.exec(command);

  assert.ok(match !== null, 'a stage command');

  return (match[1] ?? '').trim().split(/\s+/);
};

const nxStageList = async (): Promise<string[]> => {
  const project = (await readJson(join(hostDir, 'project.json'))) as {
    readonly targets: Record<
      string,
      { readonly options?: { readonly commands?: readonly string[] } }
    >;
  };
  const command = Object.values(project.targets)
    .flatMap((target) => target.options?.commands ?? [])
    .find((line) => line.includes('cli.js stage '));

  assert.ok(command !== undefined, 'project.json has a stage command');

  return stagedIn(command);
};

/** The Dockerfile with its line continuations joined. */
const dockerfile = async (): Promise<string> =>
  (await readFile(join(hostDir, '.Dockerfile'), 'utf8')).replace(
    /\\\r?\n/g,
    ' ',
  );

const dockerStageList = async (): Promise<string[]> =>
  stagedIn(await dockerfile());

/** The bundle directories of the image's `npx tsc --build` list, in order. */
const dockerTscBuildList = async (): Promise<string[]> => {
  const match = /npx tsc --build((?:\s+(?!&&|--)\S+)*)/.exec(
    await dockerfile(),
  );

  assert.ok(match !== null, 'a tsc --build command');

  return (match[1] ?? '')
    .trim()
    .split(/\s+/)
    .filter((path) => path.startsWith('bundles/'))
    .map((path) => path.replace(/\/tsconfig[^/]*\.json$/, ''));
};

/** Bundle directories the image compiles with `npx tsc -p` of their own. */
const dockerTscProjects = async (): Promise<string[]> =>
  [...(await dockerfile()).matchAll(/npx tsc -p (\S+)/g)]
    .map((match) => match[1] as string)
    .filter((path) => path.startsWith('bundles/'))
    .map((path) => path.replace(/\/tsconfig[^/]*\.json$/, ''));

const expectedPaths = async (): Promise<Map<string, string>> => {
  const paths = await bundlePathsById();
  const expected = new Map<string, string>();

  for (const id of await compositionIds()) {
    const path = paths.get(id);

    assert.ok(path !== undefined, `bundle ${id} has a source directory`);
    expected.set(id, path);
  }

  return expected;
};

const assertOpenuiBeforePapercraft = (
  list: readonly string[],
  name: string,
) => {
  const openui = list.indexOf('bundles/features/openui');
  const papercraft = list.indexOf('bundles/features/papercraft');

  assert.ok(openui >= 0, `${name} lists bundles/features/openui`);
  assert.ok(papercraft >= 0, `${name} lists bundles/features/papercraft`);
  assert.ok(openui < papercraft, `${name}: openui before papercraft`);
};

void test('H1: the shipped composition enables openui before papercraft', async () => {
  const ids = await compositionIds();

  assert.ok(ids.includes('openui'), ids.join(', '));
  assert.ok(ids.indexOf('openui') < ids.indexOf('papercraft'), ids.join(', '));
});

void test('H1: the Nx stage command stages every bundle of the composition, openui before papercraft', async () => {
  const staged = await nxStageList();

  for (const [id, path] of await expectedPaths()) {
    assert.ok(staged.includes(path), `${id} (${path}) is staged`);
  }

  assertOpenuiBeforePapercraft(staged, 'project.json stage');
});

void test('H1: the image stages every bundle of the composition, openui before papercraft', async () => {
  const staged = await dockerStageList();

  for (const [id, path] of await expectedPaths()) {
    assert.ok(staged.includes(path), `${id} (${path}) is staged`);
  }

  assertOpenuiBeforePapercraft(staged, '.Dockerfile stage');
});

void test('H1: the image compiles every bundle of the composition, openui before papercraft in tsc --build', async () => {
  const built = await dockerTscBuildList();
  const compiled = [...built, ...(await dockerTscProjects())];

  for (const [id, path] of await expectedPaths()) {
    assert.ok(compiled.includes(path), `${id} (${path}) is compiled`);
  }

  assertOpenuiBeforePapercraft(built, '.Dockerfile tsc --build');
});
