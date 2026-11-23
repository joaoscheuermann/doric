// Generated imports, the spike of A53 (spec `docs/designs/grpc-processes.md`,
// section 8, "Generated code across packages"; T1.3, AC1.4): the generated
// code of `files/v1` carries its `buf.validate` rules, so protovalidate
// refuses a request that breaks one; and `buf/validate/**` and
// `google/rpc/**` are generated in `packages/bundle/src/contracts/gen/` and
// in no other project.

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { create } from '@bufbuild/protobuf';
import { pathToString } from '@bufbuild/protobuf/reflect';
import { createValidator } from '@bufbuild/protovalidate';

import { DirectoriesRequestSchema } from '../src/contracts/gen/doric/files/v1/files_pb.js';

describe('the generated files/v1 code', () => {
  test('protovalidate refuses a DirectoriesRequest with no paths (repeated.min_items)', () => {
    const result = createValidator().validate(
      DirectoriesRequestSchema,
      create(DirectoriesRequestSchema, { paths: [] }),
    );
    assert.equal(result.kind, 'invalid');
    assert.deepEqual(
      (result.violations ?? []).map((violation) => ({
        field: pathToString(violation.field),
        ruleId: violation.ruleId,
      })),
      [{ field: 'paths', ruleId: 'repeated.min_items' }],
    );
  });

  test('protovalidate accepts a DirectoriesRequest with one path', () => {
    const result = createValidator().validate(
      DirectoriesRequestSchema,
      create(DirectoriesRequestSchema, { paths: ['src'] }),
    );
    assert.equal(result.kind, 'valid');
  });
});

/** `<root>/<group>/<project>` for each project directory under `root`. */
const projects = (root: string, depth: 1 | 2): string[] => {
  const children = (dir: string) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  const level = children(root);
  return depth === 1 ? level : level.flatMap(children);
};

describe('buf/validate and google/rpc', () => {
  const dependencies = ['buf/validate', 'google/rpc'];

  test('are generated in packages/bundle/src/contracts/gen', () => {
    for (const dependency of dependencies) {
      const dir = join('packages/bundle/src/contracts/gen', dependency);
      assert.ok(existsSync(dir), `${dir} exists`);
    }
  });

  test('are generated in no other project', () => {
    const others = [
      ...projects('bundles', 2),
      ...projects('packages', 1),
    ].filter((project) => project !== join('packages', 'bundle'));
    const found = others.flatMap((project) =>
      dependencies
        .map((dependency) => join(project, 'src/contracts/gen', dependency))
        .filter((dir) => existsSync(dir)),
    );
    assert.deepEqual(found, []);
  });
});
