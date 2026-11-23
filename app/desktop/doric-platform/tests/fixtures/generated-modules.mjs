/**
 * A module written the way a window module that uses generated code is: it
 * imports `bundle`'s generated files, `bundle/contracts` and
 * `@bufbuild/protobuf` by their import-map specifiers only, then reports
 * where each resolved and whether they share one instance (A53).
 */
import { create, isMessage } from '@bufbuild/protobuf';
import { fileDesc } from '@bufbuild/protobuf/codegenv2';
import { ContractError, toStatus } from 'bundle/contracts';
import { file_doric_platform_v1_control } from 'bundle/contracts/gen/doric/platform/v1/control_pb.js';
import {
  file_google_rpc_status,
  StatusSchema,
} from 'bundle/contracts/gen/google/rpc/status_pb.js';

const specifiers = [
  '@bufbuild/protobuf',
  '@bufbuild/protobuf/codegenv2',
  'bundle/contracts',
  'bundle/contracts/gen/doric/platform/v1/control_pb.js',
  'bundle/contracts/gen/google/rpc/status_pb.js',
];

const report = {
  resolved: Object.fromEntries(
    specifiers.map((specifier) => [specifier, import.meta.resolve(specifier)]),
  ),
  fileDesc: typeof fileDesc,
  // The control file's dependency is the very status file the module
  // imported: one generated module per window.
  controlDependsOnStatus: file_doric_platform_v1_control.dependencies.includes(
    file_google_rpc_status,
  ),
  statusIsMessage: isMessage(create(StatusSchema, { code: 5 }), StatusSchema),
  contractsStatusIsMessage: isMessage(
    toStatus(new ContractError('not_found', 'missing')),
    StatusSchema,
  ),
};

process.stdout.write(JSON.stringify(report));
