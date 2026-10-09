// The contract document generator lives in the browser-safe runtime so live
// definitions produce the same documents as the build.
export {
  type ContractDocument,
  contractDocument,
  JSON_SCHEMA_DIALECT,
  type RecordedContract,
  schemaPath,
} from '../runtime/json-schema.js';
