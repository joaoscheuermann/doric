/**
 * The binary `google.protobuf.FileDescriptorSet` of a set of descriptor files,
 * shared by the build (`descriptors.binpb`) and the router
 * (`doric.catalog/v1.Descriptors`).
 */

import { create, type DescFile, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';

/**
 * `files` and every file they import, transitively, each once (by name),
 * imports first. Pure.
 */
export const closure = (files: Iterable<DescFile>): DescFile[] => {
  const seen = new Set<string>();
  const ordered: DescFile[] = [];
  const visit = (file: DescFile): void => {
    if (seen.has(file.proto.name)) {
      return;
    }

    seen.add(file.proto.name);

    for (const dependency of file.dependencies) {
      visit(dependency);
    }

    ordered.push(file);
  };

  for (const file of files) {
    visit(file);
  }

  return ordered;
};

/**
 * The binary `FileDescriptorSet` of `files` and every file they import, each
 * once, imports first (see {@link closure}). Pure.
 */
export const descriptorSetBytes = (files: Iterable<DescFile>): Uint8Array =>
  toBinary(
    FileDescriptorSetSchema,
    create(FileDescriptorSetSchema, {
      file: closure(files).map((file) => file.proto),
    }),
  );
