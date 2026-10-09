import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { type Database, Prisma } from 'postgres/prisma';

import { defaultConfig } from '../src/lib/config/schema.js';
import { createProjectStore } from '../src/lib/workspace/projects.js';
import { json } from '../src/lib/workspace/storage.js';
import { createThreadStore } from '../src/lib/workspace/threads.js';
import { persistenceFixture } from './helpers/persistence-fixture.js';

// In production the client the kernel stores use is built by the staged
// `postgres` bundle (`dist/bundles/postgres`), while the stores import the
// generated namespace from the `postgres` package itself. Both copies must
// share Prisma's runtime, or the null markers, raw SQL tags and error classes
// the stores rely on would stop matching.

const connectionString = process.env.DORIC_TEST_DATABASE_URL;

type PrismaModule = typeof import('postgres/prisma');

const staged = async (): Promise<PrismaModule> =>
  (await import(
    pathToFileURL(resolve('agents/doric/dist/bundles/postgres/prisma.js')).href
  )) as PrismaModule;

void test("the staged bundle's generated client shares the kernel's Prisma runtime", async () => {
  const bundle = await staged();

  assert.notEqual(bundle.PrismaClient, undefined);
  assert.equal(bundle.Prisma.JsonNull, Prisma.JsonNull);
  assert.equal(bundle.Prisma.DbNull, Prisma.DbNull);
  assert.equal(bundle.Prisma.sql, Prisma.sql);
  assert.equal(
    bundle.Prisma.PrismaClientKnownRequestError,
    Prisma.PrismaClientKnownRequestError,
  );
});

void test('the kernel stores work over a client the staged bundle built', {
  skip: connectionString === undefined,
}, async () => {
  assert.ok(connectionString);
  const resources = await persistenceFixture(connectionString);
  const bundle = await staged();
  const client = new bundle.PrismaClient({
    adapter: new PrismaPg(
      { connectionString: resources.url },
      { schema: resources.schema },
    ),
  }) as unknown as Database;
  try {
    const projects = createProjectStore(client);
    const threads = createThreadStore(client);
    const { project } = await projects.create(
      'Shared runtime',
      { configuration: defaultConfig, revision: 1, updatedAt: '' },
      'blue',
    );
    const { thread } = await threads.create(project.id, 'Thread');

    // Raw SQL under a row lock, through the kernel's own tagged templates.
    assert.equal((await threads.rename(thread.id, 'Renamed'))?.name, 'Renamed');
    await threads.saveMessages(thread.id, [{ role: 'user', content: 'hi' }]);
    assert.deepEqual((await threads.find(thread.id))?.messages, [
      { role: 'user', content: 'hi' },
    ]);

    // The kernel's null markers are understood by the staged client.
    await client.thread.update({
      where: { id: thread.id },
      data: { messages: json(null), usage: Prisma.DbNull },
    });
    const [row] = await client.$queryRaw<
      { messages: unknown; usage: unknown }[]
    >`SELECT messages, usage FROM thread WHERE id = ${thread.id}::uuid`;
    assert.deepEqual(row, { messages: null, usage: null });
    // A Thread without materialized totals still answers its usage.
    assert.equal((await threads.usage(thread.id))?.total.cost, 0);

    // And its failures are the kernel's error class, with Prisma's codes.
    await assert.rejects(
      client.project.update({
        where: { id: '00000000-0000-4000-8000-0000000000ff' },
        data: { name: 'missing' },
      }),
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025',
    );
    await assert.rejects(
      client.credential.create({
        data: { kind: 'API_TOKEN', name: 'OPENROUTER_API_KEY', secret: '' },
      }),
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002',
    );
    assert.equal(
      (await projects.setState(project.id, 'ready'))?.state,
      'ready',
    );
  } finally {
    await client.$disconnect();
    await resources.close();
  }
});
