# okf

`okf` turns a repository into a local knowledge base that agents can search. Its one operation, `generate`, writes an Open Knowledge Format (OKF) bundle: a directory below `<root>/.agents/bundles` with one Markdown concept per source file and a project `index.md`. Each concept holds an analysis, a one-line description and tags written by a model the caller injects, plus the imports and exports extracted from TypeScript and JavaScript files. A concept is regenerated only when its recipe hash changes, so a second run pays only for the files that changed ([`generate.ts`](src/lib/generate.ts)).

An OKF bundle is not a Doric bundle. The package is a library for hosts written in Node.js. Its host in this repository is the runner [`scripts/okf.mjs`](../../scripts/okf.mjs) (`npm run okf`); no bundle or application imports it. The bundles it writes are read by the `okf_search` tool of [`tool-okf`](../../tools/okf/README.md). The flow between the two units is described in the feature doc [Knowledge bundles](../../docs/features/knowledge-bundles.md).

Part of [Doric](../../README.md).

## Entry point and exports

`package.json` names the package `okf` (private, ESM) and exports one entry point, `.`, plus `./package.json`. Under the `@org/source` condition `.` resolves to [`src/index.ts`](src/index.ts); otherwise to the build output `dist/src/index.js` with types in `dist/src/index.d.ts` ([`package.json`](package.json)).

[`src/index.ts`](src/index.ts) exports:

| Export           | Kind     | Defined in                                             |
| ---------------- | -------- | ------------------------------------------------------ |
| `generate`       | function | [`generate.ts`](src/lib/generate.ts)                   |
| `defaultOutput`  | function | [`generate.ts`](src/lib/generate.ts)                   |
| `OkfError`       | class    | [`classes/okf-error.ts`](src/lib/classes/okf-error.ts) |
| `isOkfError`     | function | [`classes/okf-error.ts`](src/lib/classes/okf-error.ts) |
| `OkfConfig`      | type     | [`types/okf.ts`](src/lib/types/okf.ts)                 |
| `GenerateResult` | type     | [`types/okf.ts`](src/lib/types/okf.ts)                 |
| `Progress`       | type     | [`types/okf.ts`](src/lib/types/okf.ts)                 |
| `ProgressEvent`  | type     | [`types/okf.ts`](src/lib/types/okf.ts)                 |
| `OkfErrorCode`   | type     | [`classes/okf-error.ts`](src/lib/classes/okf-error.ts) |
| `OkfErrorStage`  | type     | [`classes/okf-error.ts`](src/lib/classes/okf-error.ts) |

```ts
function generate(
  config: OkfConfig,
  root: string,
  output?: string,
): Promise<GenerateResult>;
function defaultOutput(root: string): string;
function isOkfError(value: unknown): value is OkfError;

interface OkfConfig {
  readonly provider: LlmProvider; // from `llms`; required
  readonly model: string; // required model id
  readonly effort?: ReasoningEffort; // from `llms`; sent as is, `undefined` when omitted
  readonly promptTarget?: string; // default 'default'
  readonly batchSize?: number; // default 5
  readonly ignore?: readonly string[]; // default []
  readonly signal?: AbortSignal;
  readonly progress?: Progress;
}

interface GenerateResult {
  readonly root: string; // the root, absolute, symbolic links resolved
  readonly output: string; // the bundle directory, absolute
  readonly index: string; // `<output>/index.md`
  readonly files: readonly string[]; // root-relative `/`-separated paths, sorted
  readonly generated: number; // concepts written by this run
  readonly cached: number; // concepts reused by this run
}

type Progress = (event: ProgressEvent) => void;
```

`LlmProvider` and `ReasoningEffort` come from [`llms`](../llms/README.md). The defaults are in [`constants.ts`](src/lib/constants.ts) and [`generate.ts`](src/lib/generate.ts).

`defaultOutput(root)` returns `path.resolve(root)/.agents/bundles/project`, without resolving symbolic links ([`generate.ts`](src/lib/generate.ts)).

## Usage

```ts
import { generate, isOkfError } from 'okf';

try {
  const result = await generate(
    {
      provider,
      model: 'model-id',
      effort: 'low',
      progress: (event) => log(event),
    },
    repositoryRoot,
  );
  console.log(`${result.generated} generated, ${result.cached} cached`);
} catch (error) {
  if (isOkfError(error))
    log(
      {
        code: error.code,
        stage: error.stage,
        source: error.source,
        hint: error.hint,
      },
      error.message,
    );
  else log('OKF generation failed');
}
```

## What `generate` does

`generate(config, root, output?)` runs these steps in order; the first failure rejects the returned promise ([`generate.ts`](src/lib/generate.ts)).

1. **Root.** The root is resolved to an absolute real path (symbolic links resolved). If that fails or the path is not a directory, it rejects with `OKF_ROOT_INVALID`.
2. **Output.** Without `output`, the bundle directory is `<root>/.agents/bundles/project`. An explicit `output` is absolute or relative to the real root. It must be a strict child of `<root>/.agents/bundles` as written. It is then checked once more after symbolic links and junctions are resolved, by projection, since neither directory needs to exist yet: the projected path of a directory is the real path of its nearest existing ancestor with the remaining, not-yet-existing segments appended (a missing path, `ENOENT` or `ENOTDIR`, moves the search one level up). The projected `<root>/.agents/bundles` must lie strictly inside the real root, and the projected output strictly inside the projected `<root>/.agents/bundles`. A first run with no `.agents` directory therefore passes. A failed check, or any other error while resolving, rejects with `OKF_OUTPUT_INVALID`. `result.output` is the output as written, resolved against the real root.
3. **Prompts.** The three prompts of `promptTarget` are loaded once ([Prompts](#prompts)); a failure rejects with `OKF_PROMPT_LOAD_FAILED`.
4. **Start.** It emits `okf.generate.start` with the batch size, then creates the output directory recursively; a failure rejects with `OKF_OUTPUT_PREPARE_FAILED`.
5. **Discovery and batches.** It discovers the files ([Discovery](#discovery)) and processes them in batches ([Processing one file](#processing-one-file)).
6. **Index.** It emits `okf.index.start`, reads the `description` of the concept of every processed file and writes `<output>/index.md` ([The project index](#the-project-index)); a failure rejects with `OKF_INDEX_FAILED`. It then emits `okf.index.complete` and `okf.generate.complete` and returns the `GenerateResult`.

`generate` never deletes anything: a concept whose source file is gone or now ignored stays in the output directory, and the index does not list it. No file named `log.md` is written; the name is only reserved ([`tree.ts`](src/lib/tree.ts)).

### Discovery

Discovery lists every file below the root with the glob patterns `**/*` and `**/.gitignore`, without following symbolic links into directories ([`walk.ts`](src/lib/walk.ts)):

- A path that has a file or directory name starting with `.` is not discovered, except a `.gitignore` file outside such a directory. Everything under `.agents`, `.doric`, `.git` and `.github` is therefore excluded, and so are files such as `.env`.
- Only regular files remain (checked with `lstat`); symbolic links are dropped.
- `.gitignore` files are rules, never sources ([`git.ts`](src/lib/git.ts)). They are read shallowest first (by depth, then by `localeCompare` of the path); one that is itself ignored by the caller's patterns or by a shallower `.gitignore` is not read, and one that cannot be read is skipped. Each applies to the paths below its own directory, relative to that directory, with gitignore semantics (the `ignore` package); a deeper file's negation un-ignores what a shallower one ignored. `.git/info/exclude` and global excludes are not read.
- `config.ignore` holds gitignore-syntax patterns matched against the root-relative path. They are applied in addition to the `.gitignore` rules.

The remaining paths are sorted (default `Array.prototype.sort`, UTF-16 code-unit order) and split into batches of `batchSize` in that order. `batchSize` must be a safe positive integer; otherwise `generate` rejects with a plain `Error` (`batchSize must be a positive integer`) after `okf.generate.start` and after the output directory is created. Batches run one after another; the files of a batch run concurrently. Before each batch and before each file, `signal.throwIfAborted()` runs. For each file, the walker checks again that it is a regular file (one that vanished is skipped silently), reads it, and skips binary content: a file with a NUL byte, with invalid UTF-8, or whose bytes are more than 30% control characters (below 32, other than tab, line feed and carriage return). An empty file is text. A failure while listing or filtering paths, or while reading a file, rejects with `OKF_DISCOVERY_FAILED`. Every other file is decoded as UTF-8 and processed; its root-relative `/`-separated path is its _source_ ([`walk.ts`](src/lib/walk.ts)).

A failing file rejects `generate`, but the other files of its batch are not cancelled: they run to their end, may still write their concepts, and keep sending progress events unless the progress observer itself threw ([Progress events](#progress-events)).

### Processing one file

For each source ([`generate.ts`](src/lib/generate.ts)):

1. Emit `okf.file.start`.
2. Detect its **type**: the lowercase final extension without the dot, or `no-extension` ([`detect.ts`](src/lib/detect.ts)).
3. For a supported type, parse it and extract its **module interface** ([Parsing and the module interface](#parsing-and-the-module-interface)). This runs on every run, cache hit or not; a parse or syntax failure rejects before the provider is called.
4. Compute the **recipe hash** ([Cache](#cache)) and the concept path ([Concept files](#concept-files)).
5. If the existing concept carries the same hash, emit `okf.file.cached` and stop: no provider call, no write.
6. Otherwise emit `okf.file.cache.miss` and run the three completions in order ([Model calls](#model-calls)), each between its `start` and `complete` events. A `complete` event is emitted only after that stage's result is accepted; a failing stage stops the file, and no later call or write happens.
7. Create the concept's parent directories and write the concept with the current time as `timestamp`; a failure rejects with `OKF_CONCEPT_WRITE_FAILED`. Emit `okf.file.generated`.

### Parsing and the module interface

Tree-sitter strictly parses nine types ([`interface.ts`](src/lib/interface.ts), [`detect.ts`](src/lib/detect.ts)): `ts`, `mts` and `cts` with the TypeScript grammar; `tsx` with the TSX grammar; `js`, `mjs`, `cjs` and `jsx` with the JavaScript grammar; `json` with the JSON grammar. Every other type, JSONC and JSON5 included, is plain text and is not parsed.

- **Buffer.** The parser buffer is the source's UTF-16 length plus one, at least 32,768, rounded up to the next power of two. A size that is not a safe integer or exceeds `0xFFFFFFFF`, or a failure to build the parser, set its language or parse, rejects with `OKF_SOURCE_PARSE_FAILED` (stage `parse`).
- **Syntax.** A tree with any error node rejects with `OKF_SOURCE_SYNTAX_INVALID` (stage `syntax`).
- **JSON** is only validated: it has no module interface.

For the TypeScript and JavaScript types the module interface is `{ imports?, exports? }`, each key present only when non-empty; a file with neither has the interface `{}` ([`types/interface.ts`](src/lib/types/interface.ts)).

**Imports** ([`imports.ts`](src/lib/imports.ts), [`resolve.ts`](src/lib/resolve.ts)) come from `import` statements, TypeScript `import x = require('m')`, `import('m')` and `require('m')` calls with a string-literal argument anywhere in the file, and re-exports (`export … from 'm'`). Entries with the same specifier are merged. Each entry is `{ source, target?, symbols }`:

- `symbols` is the sorted, de-duplicated list of what is bound: `default as X`, `* as NS`, `name`, `name as alias`, each prefixed `type ` when type-only; `*` for `export * from`; for `require`, `default as x` when bound to an identifier, or the destructuring pattern with whitespace collapsed; empty for a bare or dynamic import.
- A specifier starting with `.` is **relative** and gets a `target`. The specifier is resolved against the source's directory; outside the root it is `null`. Candidates, in order: the path itself; when it has no extension, the path plus `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.json`; then `index.<ext>` inside it for the same extensions. The first candidate that is a regular file whose real path is inside the root wins, as a root-relative path; none gives `null`. A specifier with an extension does not try other extensions, so `./x.js` does not resolve to `x.ts`.
- Every other specifier (package, alias, absolute, `node:` built-in) is **external** and has no `target`.
- `imports.relative` and `imports.external` are each sorted by `source`.

**Exports** ([`exports.ts`](src/lib/exports.ts)) are grouped into `classes`, `methods`, `functions`, `variables`, `types` and `reexports`, each sorted and present only when non-empty:

- Declarations exported with `export` (including `declare` forms): a class by name; a function as `name(params)returnType`; a variable as `name` plus its type annotation; a type as `interface X`, `type X`, `enum X` or `namespace X`.
- `export { a, b as c }` uses the declaration of each local name, renamed to the alias; an undeclared name is a variable.
- `export default function foo` and `export default class Foo` are declarations and keep their own names. `export default <value>` exports the name `default`: a referenced declaration renamed to `default`; an anonymous class as `default` with its members; a function as `default(params)returnType`; anything else as the variable `default`. `export = <value>` follows the same rules with the value's source text as the name, so `export = Foo` exports the declaration `Foo` under its own name.
- CommonJS: `module.exports = { … }` exports each property by key; `module.exports = value` exports `default`; `exports.name =`, `module.exports.name =` and `exports['name'] =` export `name`. Each value is classified by the same rules as `export default <value>`.
- The public members of an exported class are `methods`: methods, accessors (`Class.get name()`), constructors and fields, as `Class.name(params)returnType` or `Class.field: type`, under the exported name. Members named `#private` or marked `private` or `protected` are left out.
- `reexports` holds the symbols of every `export … from`.

### Model calls

A cache miss makes three sequential completions through the injected provider ([`agent.ts`](src/lib/agent.ts), [`summarize.ts`](src/lib/summarize.ts)). Each is one `provider.complete` call with a system message (the stage's prompt) and a user message, `model`, `effort`, `temperature: 0`, `maxOutputTokens: 4096` and `signal`; no tools, no structured output and no response schema. The answer's `text` is trimmed. A rejected call that is not a cancellation, or an empty answer, fails the stage; the provider's error is discarded.

1. **Analysis** (stage `summary`). The user message is a Markdown document: the heading `# File Evidence`, then the sections `## Path` (the source in a `text` fence), `## Type` (the type in a `text` fence), `## Module Interface` (the interface as YAML in a `yaml` fence, only for TypeScript and JavaScript) and `## Content`, every part joined by one blank line. Content gives `UTF-8 bytes: <n>` and `Terminal newline: yes|no`, then the exact source in a `json` fence for the `json` type and a `text` fence otherwise; a value without a final newline gets one inside the fence. Every fence is collision-safe: it uses the marker (backtick or tilde) whose longest run in the value is shorter, backticks on a tie, repeated one more time than that run and at least three times. The answer must be non-empty and must not begin with a line that is exactly `---`; otherwise the stage fails with `OKF_SUMMARY_FAILED`.
2. **Description** (stage `description`). The user message is `# Source Summary` followed by the analysis in a collision-safe `text` fence; it carries no path, type, interface or content. Any non-empty answer is the description, kept exactly as trimmed (length, punctuation and internal newlines included). An empty answer fails with `OKF_DESCRIPTION_FAILED`.
3. **Tags** (stage `tags`). The user message is the same `# Source Summary` document. An empty answer fails with `OKF_TAGS_FAILED`; any other answer becomes a list of tags as follows.

Tag parsing ([`summarize.ts`](src/lib/summarize.ts)). Line endings are normalized to `\n` and the answer is trimmed. If the whole answer is one Markdown fence (three or more backticks or tildes, an optional info string on the opening line, closed by the same run), its trimmed body is used; any other run of three or more backticks or tildes anywhere makes the answer unrecognized. Then:

- An answer starting with `[` must be a JSON array of strings; one starting with `{` must be a plain JSON object whose only key is `tags`, an array of strings.
- Otherwise it is plain text. An optional leading `Tags:` (any case) is stripped. More than one non-empty line gives one item per line. A single line is split on commas when it had the `Tags:` label or when no comma-separated part contains `.`, `?` or `!`; otherwise it is one item.
- Each item, untrimmed, loses one list marker at its very start (`-`, `*`, `+`, or any number followed by `.` or `)`, then whitespace; an indented `  - a` keeps its marker), then one matching pair of surrounding `'`, `"` or `` ` ``, and is trimmed; empty items are dropped. Case, punctuation, order and duplicates are kept.
- When the answer is unrecognized (bad fence, invalid JSON, a non-string item, other keys) or no item remains, the tags are one item: the whole trimmed answer.

Every readable source body, including values that may be sensitive, is sent unchanged to the provider the caller configured. The caller chooses a provider and a repository scope fit for that disclosure. The package does no logging of its own, and what the provider logs is set by the provider's configuration; the runner configures its provider with a disabled logger.

### Prompts

The three system prompts live in the package ([`prompts.ts`](src/lib/prompts.ts)):

```text
prompts/summarize/<target>/SYSTEM_PROMPT.md
prompts/describe/<target>/SYSTEM_PROMPT.md
prompts/tags/<target>/SYSTEM_PROMPT.md
```

`<target>` is `config.promptTarget`, `default` when omitted. It must match `^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`, must not be a Windows device name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, alone or before a dot) and must not be `scenarios`. Each file is looked up from the directory of the loaded module upward to the filesystem root, so the same `prompts/` tree serves the source and the build. Each prompt is read and trimmed and must be non-empty. An invalid target, or a missing, unreadable or empty prompt, rejects with `OKF_PROMPT_LOAD_FAILED`; there is no fallback to `default`. A new target is a new directory with the same three files.

The `default` prompts ask for: an evidence-grounded Markdown analysis of purpose, behavior, interfaces and relationships, without front matter, tags, JSON or secrets ([`summarize`](prompts/summarize/default/SYSTEM_PROMPT.md)); one plain-text sentence of 1 to 240 characters ending in `.`, `!` or `?` ([`describe`](prompts/describe/default/SYSTEM_PROMPT.md)); one to six unique lowercase-kebab-case tags, one per line ([`tags`](prompts/tags/default/SYSTEM_PROMPT.md)). These forms are requests to the model; at runtime only the rules of [Model calls](#model-calls) apply.

### Cache

A concept's `hash` is the lowercase hex SHA-256 of the UTF-8 string `JSON.stringify(recipe)`, where `recipe` is this object, with its keys in this order ([`recipe.ts`](src/lib/recipe.ts)):

```text
{
  source: { hash, path, type },
  interface,
  versions: { parser, extractor, yaml, conceptSchema, plainTextFields, pipeline },
  prompts: { target, summary, description, tags },
  completion: { provider, model, effort }
}
```

- `source.hash` is the lowercase hex SHA-256 of the decoded content; `source.path` is the source and `source.type` its type.
- `interface` is the module interface as written to the concept (`{}` for a TypeScript or JavaScript file with no imports or exports), or `null` for every other type.
- `versions` holds fixed strings: `parser` is `tree-sitter@0.21.1|tree-sitter-javascript@0.23.1|tree-sitter-typescript@0.23.2|tree-sitter-json@0.24.8|buffer-next-power-of-two-v1` and `extractor` is `module-interface-v2` ([`interface.ts`](src/lib/interface.ts)); `yaml` is `2.9.0` and `conceptSchema` is `okf-yaml-v1` ([`recipe.ts`](src/lib/recipe.ts)); `plainTextFields` is `plain-text-fields-v4` and `pipeline` is `summary-description-tags-v1` ([`constants.ts`](src/lib/constants.ts)).
- `prompts.target` is the prompt target and the other three are the exact trimmed text of the loaded prompts.
- `completion.provider` is `provider.metadata.id`, `completion.model` the model, and `completion.effort` the effort or `null`.

A file is a cache hit when its concept file exists, starts with a `---` front matter block that parses as YAML without errors or duplicate keys, and its `hash` equals the computed hash as a string ([`concept.ts`](src/lib/concept.ts)). A missing concept, unparsable front matter or another hash is a miss. A read error other than a missing file rejects with `OKF_CACHE_READ_FAILED`. A change to the content, the path, the extracted relationships of any import, a prompt, a version, the provider, the model or the effort makes every affected concept a miss.

## Data written

### Concept files

The concept of a source is `<output>/<source>.md`; when the file name of the source matches `index` or `log` (any case) followed by any number of `.md`, it is `<source>.md.md`, so that no concept collides with the bundle's `index.md` or a `log.md` ([`tree.ts`](src/lib/tree.ts)). A concept is YAML front matter followed by the trimmed analysis ([`concept.ts`](src/lib/concept.ts)). For a source `src/greet.ts` that imports `readFile` from `node:fs/promises` and `normalize` from `./names` (an existing `src/names.ts`) and exports `async function greet(path: string): Promise<string>`, the concept `src/greet.ts.md` is, byte for byte apart from the hash:

```text
---
id: "src/greet.ts"
title: "greet"
type: "ts"
description: "Reads a file and returns its normalized text."
resource: "source:src/greet.ts"
tags: [ "greeting", "file-io" ]
timestamp: "2026-11-20T12:00:00.000Z"
hash: "<64 lowercase hex characters>"
imports:
  relative:
    - source: "./names"
      target: "src/names.ts"
      symbols: [ "normalize" ]
  external:
    - source: "node:fs/promises"
      symbols: [ "readFile" ]
exports:
  functions: [ "greet(path: string): Promise<string>" ]
---

# Greeting

Reads a file and normalizes it.
```

The keys come in this order: `id` (the source), `title` (the file name without its final extension), `type`, `description`, `resource` (`source:` plus the source), `tags`, `timestamp` (ISO 8601, the time of writing), `hash`, then `imports` and `exports` when the module interface has them. Keys are plain, every string is double-quoted, lines are not wrapped (a description keeps its newlines as `\n` escapes), and every list of strings is written in flow style with a space inside each bracket (`[ "a", "b" ]`, `[]` when empty); the `imports` entries are block lists of maps (the `yaml` package's `toString` with `defaultKeyType: 'PLAIN'`, `defaultStringType: 'QUOTE_DOUBLE'`, `lineWidth: 0`). The file ends with one newline after the analysis.

### The project index

`<output>/index.md` is rewritten on every run from the processed files only ([`tree.ts`](src/lib/tree.ts)). It is `# Project`, a blank line, then a nested list with the entries of each level sorted by name in UTF-16 code-unit order (a plain `<` comparison, not `localeCompare`): a directory as `- name/`, a file as `- [path](link) - description`, indented two spaces per level. Duplicate paths keep one entry. The file label is the full source path and the directory label its name, each with `\`, `[`, `]`, `` ` ``, `*`, `_`, `<`, `>`, `&` and `~` escaped; the link is the concept path, each segment URI-encoded (with `!'()*` encoded as well). The description is read from the concept's front matter, which must be valid YAML with a string `description`; whitespace runs are folded to one space in the index only. Reading a concept or writing the index fails with `OKF_INDEX_FAILED`.

```markdown
# Project

- [README.md](README.md.md) - Describes the repository.
- src/
  - [src/index.ts](src/index.ts.md) - Re-exports the public API.
```

## Progress events

`config.progress` receives `ProgressEvent` values synchronously ([`types/okf.ts`](src/lib/types/okf.ts), [`generate.ts`](src/lib/generate.ts)):

| Event                                                         | Fields                         | When                                                      |
| ------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| `okf.generate.start`                                          | `batchSize`                    | After the prompts load, before the output is created      |
| `okf.file.start`                                              | `source`                       | A text file starts processing                             |
| `okf.file.cache.miss`                                         | `source`                       | The hash differs                                          |
| `okf.file.summary.start`, `okf.file.summary.complete`         | `source`                       | Around the analysis                                       |
| `okf.file.description.start`, `okf.file.description.complete` | `source`                       | Around the description                                    |
| `okf.file.tags.start`, `okf.file.tags.complete`               | `source`                       | Around the tags                                           |
| `okf.file.cached`, `okf.file.generated`                       | `source`, `processed`          | The file ends; `processed` counts files ended in this run |
| `okf.index.start`, `okf.index.complete`                       | `files`                        | Around the index                                          |
| `okf.generate.complete`                                       | `files`, `generated`, `cached` | Before `generate` resolves                                |

The events of the files of one batch interleave. Binary and vanished files emit nothing. If the observer throws, `generate` rejects with that same exception and the observer receives no further event. If `generate` rejects for another reason, the other files of the running batch go on and the observer keeps receiving their events.

## Errors

A known operational failure rejects with an `OkfError` ([`classes/okf-error.ts`](src/lib/classes/okf-error.ts)):

```ts
class OkfError extends Error {
  // `name` (inherited, type `string`) is set to 'OkfError' at runtime
  readonly code: OkfErrorCode;
  readonly stage: OkfErrorStage;
  readonly hint: string;
  readonly source?: string; // normalized root-relative path, only for source-scoped codes
}
```

Only the package creates one: calling the constructor from outside throws `Error('OkfError cannot be constructed outside the OKF package.')`. `isOkfError(value)` is true only for instances the package created (it checks a private `WeakSet`), so an object with a forged prototype or the same fields returns `false`; an object whose prototype is set to `OkfError.prototype` passes `instanceof` but not `isOkfError`; `isOkfError` is the check that guarantees the safety below. An `OkfError` holds no `cause`, and its `message`, `hint`, `code`, `stage` and `source` are fixed by the package and safe to log: they never contain an absolute path, provider or filesystem diagnostics, source text, a prompt, a model answer, a credential, or anything from a caught error. `source` is a non-empty relative path with `/` separators and no empty, `.` or `..` segment.

| Code                        | Stage         | `source` | Message                                                             | Hint                                                                                                    |
| --------------------------- | ------------- | -------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `OKF_ROOT_INVALID`          | `setup`       | no       | The OKF repository root is unavailable or is not a directory.       | Check that the repository path exists and is readable.                                                  |
| `OKF_OUTPUT_INVALID`        | `setup`       | no       | The OKF output directory must stay inside .agents/bundles.          | Use the default output or choose a child of .agents/bundles.                                            |
| `OKF_OUTPUT_PREPARE_FAILED` | `setup`       | no       | Could not prepare the OKF output directory.                         | Check directory permissions and conflicting files.                                                      |
| `OKF_PROMPT_LOAD_FAILED`    | `prompt`      | no       | Could not load the OKF prompts for the selected target.             | Check promptTarget and the summarize/describe/tags prompt files.                                        |
| `OKF_DISCOVERY_FAILED`      | `discovery`   | no       | Could not discover readable repository files.                       | Check repository permissions and filesystem entries.                                                    |
| `OKF_SOURCE_PARSE_FAILED`   | `parse`       | yes      | Could not parse supported source `<source>`.                        | Retry with a smaller file or more available memory.                                                     |
| `OKF_SOURCE_SYNTAX_INVALID` | `syntax`      | yes      | Supported source syntax is invalid for `<source>`.                  | Fix the syntax error or exclude the file.                                                               |
| `OKF_CACHE_READ_FAILED`     | `cache`       | yes      | Could not read the cached concept for `<source>`.                   | Check the generated bundle file and its permissions.                                                    |
| `OKF_SUMMARY_FAILED`        | `summary`     | yes      | The model could not produce a valid source summary for `<source>`.  | Confirm the configured provider is reachable, the model is available, and it can return non-empty text. |
| `OKF_DESCRIPTION_FAILED`    | `description` | yes      | The model could not produce a non-empty description for `<source>`. | Confirm the model is available and can return non-empty text.                                           |
| `OKF_TAGS_FAILED`           | `tags`        | yes      | The model could not produce non-empty tags for `<source>`.          | Confirm the model is available and can return non-empty text.                                           |
| `OKF_CONCEPT_WRITE_FAILED`  | `write`       | yes      | Could not write the generated concept for `<source>`.               | Check bundle permissions and available disk space.                                                      |
| `OKF_INDEX_FAILED`          | `index`       | no       | Could not build or write the OKF project index.                     | Check generated concepts and bundle permissions.                                                        |

In each message `<source>` is replaced by the source path; the error's `name` is `OkfError`.

Other rejections pass through unchanged; the package makes no guarantee about their message or contents (the runner logs them with a fixed message):

- **Cancellation.** An error named `AbortError` crosses every boundary unchanged. Inside a completion, an aborted signal (before or after the call) or an `AbortError` from the provider rejects with a fresh `DOMException('The operation was aborted.', 'AbortError')`. Between batches and files, `signal.throwIfAborted()` rejects with the signal's reason. The signal is not checked during the index.
- **A progress observer's exception**, as is.
- **An invalid `batchSize`**, as a plain `Error`.
- **An unexpected filesystem error while resolving a relative import** (any error other than a missing path), as is ([`resolve.ts`](src/lib/resolve.ts)).

## Repository runner

```console
npm run okf -- <model-id>
```

The root script runs [`scripts/okf.mjs`](../../scripts/okf.mjs) from source (`--conditions=@org/source` with the SWC loader). It generates this repository's bundle at `.agents/bundles/project` with the default prompt target and batch size, using the OpenAI Responses-compatible provider of `llms` with a fetch transport and a disabled provider logger. `OKF_BASE_URL` sets the endpoint (default `http://localhost:1234/v1`) and `OKF_API_KEY` its key (none by default). It logs each progress event with `pino` to stderr, formatted by `pino-pretty` (colorized only when stderr is a terminal), redacting tokens, API keys and authorization headers. On an `OkfError` it logs `code`, `stage`, `source` and `hint` with the message; on a `DOMException` named `AbortError` it logs the warning `OKF generation cancelled`; any other failure is logged as `OKF generation failed unexpectedly`, with `Retry the operation or report the failure.` as its hint. Without a model id it logs the error `Usage: npm run okf -- <model-id>`. Every failure sets exit code 1.

## Build and test

```console
npx nx build okf       # tsc --build tsconfig.lib.json → packages/okf/dist
npx nx typecheck okf   # tsc -p packages/okf/tsconfig.lib.json --noEmit
npx nx test okf        # builds, compiles tests to dist-tests, runs node --test
```

`build` is inferred by the `@nx/js/typescript` plugin; `typecheck` and `test` are in [`project.json`](project.json). The tests under [`tests/`](tests) use a fake provider ([`fakes.ts`](tests/fakes.ts)) and cover `generate` end to end, with the three calls, tag parsing, progress, cache and its errors, asserting every code but `OKF_SOURCE_PARSE_FAILED` (`OKF_OUTPUT_INVALID` by its message) (`generate.test.ts`), the module interface and `OKF_SOURCE_PARSE_FAILED` (`interface.test.ts`), the evidence document, the recipe hash and the concept format (`pipeline.test.ts`), concept paths and the index (`tree.test.ts`) and discovery (`walk.test.ts`). Dependencies declared in [`package.json`](package.json): `llms`, `glob`, `ignore`, `yaml` and the Tree-sitter packages `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-json` and `tree-sitter-typescript`, all imported by `src`; `zod` and `tslib` are declared too, and `src` imports neither.
