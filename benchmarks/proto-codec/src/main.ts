/**
 * The phase 0 codec benchmark (docs/designs/grpc-processes.md, section 8,
 * "The benchmark"): each case four ways, on the Node that runs it, with
 * `node:perf_hooks`. Prints a Markdown table, writes the results to
 * `dist/proto-codec/results-<arch>.json`, and reports the decision rule's
 * ratio on the Thread snapshot: protobuf-es binary decoding plus
 * protovalidate against `v8.deserialize` plus zod. The rule is the owner's
 * decision, so the run reports it and does not fail on it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';

import {
  fromBinary,
  fromJsonString,
  toBinary,
  toJsonString,
} from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';

import { type Measurement, measure } from './measure.js';
import { buildCases, type Case } from './messages.js';

/** The decision rule's bound (section 8, A56). */
const MAX_RATIO = 4;

/** Protobuf's standard JSON mapping as the contracts write it (A16). */
const JSON_WRITE = { alwaysEmitImplicit: true } as const;
const JSON_READ = { ignoreUnknownFields: false } as const;

const RESULTS_DIRECTORY = 'dist/proto-codec';

const validator = createValidator();

const iterationsFor = (bytes: number) =>
  Math.max(2000, Math.min(20_000, Math.floor(200_000_000 / bytes)));

interface Row {
  readonly operation: string;
  readonly result: Measurement;
}

const runCase = (entry: Case) => {
  const { schema, messages, today, zod } = entry;
  const binary = messages.map((message) => toBinary(schema, message));
  const json = messages.map((message) =>
    toJsonString(schema, message, JSON_WRITE),
  );
  const v8 = serialize(today);
  const bytes = binary.reduce((sum, part) => sum + part.length, 0);
  const options = { warmup: 500, iterations: iterationsFor(bytes) };

  const validate = (decoded: readonly unknown[]) => {
    for (const message of decoded) {
      const result = validator.validate(schema, message as never);
      if (result.kind !== 'valid') {
        throw new Error(
          `${entry.name}: ${result.kind} ${String(result.error)}`,
        );
      }
    }
    return decoded;
  };
  // Every way decodes what it encoded and checks it once before timing.
  validate(binary.map((part) => fromBinary(schema, part)));
  zod.parse(deserialize(v8));

  const rows: Row[] = [
    {
      operation: 'protobuf-es toBinary',
      result: measure(
        () => messages.map((message) => toBinary(schema, message)),
        options,
      ),
    },
    {
      operation: 'protobuf-es fromBinary',
      result: measure(
        () => binary.map((part) => fromBinary(schema, part)),
        options,
      ),
    },
    {
      operation: 'protobuf-es toJson (string)',
      result: measure(
        () =>
          messages.map((message) => toJsonString(schema, message, JSON_WRITE)),
        options,
      ),
    },
    {
      operation: 'protobuf-es fromJson (string)',
      result: measure(
        () => json.map((part) => fromJsonString(schema, part, JSON_READ)),
        options,
      ),
    },
    {
      operation: 'v8.serialize',
      result: measure(() => serialize(today), options),
    },
    {
      operation: 'v8.deserialize',
      result: measure(() => deserialize(v8), options),
    },
    {
      operation: 'protovalidate validate',
      result: measure(() => validate(messages), options),
    },
    {
      operation: 'zod parse',
      result: measure(() => zod.parse(today), options),
    },
    {
      operation: 'decode: fromBinary + protovalidate',
      result: measure(
        () => validate(binary.map((part) => fromBinary(schema, part))),
        options,
      ),
    },
    {
      operation: 'decode: v8.deserialize + zod',
      result: measure(() => zod.parse(deserialize(v8)), options),
    },
  ];
  const decode = (name: string) =>
    rows.find((row) => row.operation === name)?.result.mean ?? Number.NaN;
  const ratio =
    decode('decode: fromBinary + protovalidate') /
    decode('decode: v8.deserialize + zod');

  return {
    name: entry.name,
    sizes: {
      binary: bytes,
      json: json.reduce((sum, part) => sum + part.length, 0),
      v8: v8.length,
    },
    iterations: options.iterations,
    rows,
    ratio,
  };
};

const format = (value: number, digits = 3) => value.toFixed(digits);

const results = buildCases().map(runCase);

console.log(`# proto-codec on Node ${process.version} (${process.arch})\n`);
for (const result of results) {
  console.log(`## ${result.name}\n`);
  console.log(
    `Sizes: protobuf binary ${result.sizes.binary} B, protobuf JSON ${result.sizes.json} B, v8 ${result.sizes.v8} B; ${result.iterations} iterations.\n`,
  );
  console.log('| Operation | ops/s | mean ms | p50 ms | p99 ms |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const { operation, result: row } of result.rows) {
    console.log(
      `| ${operation} | ${format(row.opsPerSecond, 0)} | ${format(row.mean)} | ${format(row.p50)} | ${format(row.p99)} |`,
    );
  }
  console.log(
    `\nDecode ratio (fromBinary + protovalidate) / (v8.deserialize + zod): ${format(result.ratio, 2)}\n`,
  );
}

const snapshot = results.find((result) => result.name === 'Thread snapshot');
const passed = snapshot !== undefined && snapshot.ratio <= MAX_RATIO;
console.log(
  `Decision rule (section 8): Thread snapshot ratio ${format(snapshot?.ratio ?? Number.NaN, 2)} ${passed ? '<=' : '>'} ${MAX_RATIO}: ${passed ? 'pass' : 'fail, the spec is revised before phase 1'}.`,
);

const resultsFile = `${RESULTS_DIRECTORY}/results-${process.arch}.json`;
mkdirSync(RESULTS_DIRECTORY, { recursive: true });
writeFileSync(
  resultsFile,
  `${JSON.stringify(
    {
      node: process.version,
      arch: process.arch,
      date: new Date().toISOString(),
      rule: {
        case: 'Thread snapshot',
        maxRatio: MAX_RATIO,
        ratio: snapshot?.ratio ?? null,
        passed,
      },
      cases: results.map(({ name, sizes, iterations, rows, ratio }) => ({
        name,
        sizes,
        iterations,
        decodeRatio: ratio,
        operations: rows.map(({ operation, result }) => ({
          operation,
          opsPerSecond: result.opsPerSecond,
          meanMs: result.mean,
          p50Ms: result.p50,
          p99Ms: result.p99,
        })),
      })),
    },
    null,
    2,
  )}\n`,
);
console.log(`Results written to ${resultsFile}.`);
