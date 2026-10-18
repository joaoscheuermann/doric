# OKF package

`okf` turns a repository into a local knowledge base that agents can search.
It generates an Open Knowledge Format bundle with one Markdown concept per
source file: an analysis, a one-line description and tags written by a model
you choose, plus the file's extracted imports and exports. Results are cached
by a hash of the whole generation recipe, so re-running it only pays for files
that changed. Doric's [`tool-okf`](../../tools/okf/README.md) search tool reads
the bundles it writes.

Part of [Doric](../../README.md).

## Highlights

- **Whole-repository coverage.** Discovers the complete regular-file
  snapshot, respects scoped `.gitignore` rules and caller-provided ignores,
  excludes symbolic links and binary content, and processes every remaining
  readable text file in bounded concurrent batches.
- **Bring your own model.** Any injected `LlmProvider` and model from the
  `llms` package; no provider is built in.
- **Structure, not just prose.** Tree-sitter validates TS, JS and JSON, and
  extracts imports, exports and public class members for TS and JS.
- **Precise caching.** Unchanged files under the same recipe make zero
  provider calls.
- **Safe failures.** A closed, curated `OkfError` that hosts can log without
  leaking paths, source or model output.

## Usage

```ts
import { defaultOutput, generate } from 'okf';

const result = await generate(
  {
    provider,
    model: 'model-id',
    effort: 'low',
    batchSize: 5,
  },
  repositoryRoot,
);

console.log(result.output === defaultOutput(repositoryRoot));
```

## API

### `generate(config, root, output?)`

`generate` requires an injected `LlmProvider` and model.

| Field          | Notes                                                     |
| -------------- | --------------------------------------------------------- |
| `provider`     | Required `LlmProvider`.                                   |
| `model`        | Required model ID.                                        |
| `effort`       | Optional reasoning effort.                                |
| `promptTarget` | Prompt variant directory; `default` when omitted.         |
| `batchSize`    | Files processed concurrently per batch; `5` when omitted. |
| `ignore`       | Additional ignore patterns.                               |
| `signal`       | An `AbortSignal` that cancels generation.                 |
| `progress`     | A `Progress` observer that receives `ProgressEvent`s.     |

The default output is `<root>/.agents/bundles/project` (`defaultOutput(root)`).
An explicit absolute or root-relative output must be a child of
`<root>/.agents/bundles`, including after existing symbolic links and
junctions are resolved. The `.agents`, `.doric` and `.git` directories are
never read as sources.

### Result

The `GenerateResult` reports canonical `root`, `output` and `index` paths;
represented source paths (`files`); and `generated` versus `cached` counts.
Concepts mirror source paths without colliding with reserved `index.md` or
`log.md` names. The root `index.md` is regenerated deterministically.

### Exports

`generate`, `defaultOutput`, `OkfError`, `isOkfError`, and the types
`OkfConfig`, `GenerateResult`, `Progress`, `ProgressEvent`, `OkfErrorCode` and
`OkfErrorStage`.

## Processing contract

### Source types and parsing

The YAML `type` is the lowercase final extension, or `no-extension`.
Tree-sitter strictly validates these extensions:

- `ts`, `mts`, and `cts` use the TypeScript grammar;
- `tsx` uses the TSX grammar;
- `js`, `mjs`, `cjs`, and `jsx` use the JavaScript/JSX grammar;
- `json` uses the JSON grammar for syntax validation only.

A syntax error in one of those formats rejects `generate` before that file is
sent to the provider or written as a concept. JSONC, JSON5, and every other
extension remain ordinary text formats.

Tree-sitter receives a per-source buffer sized from the JavaScript UTF-16
length, rounded up to the next power of two with a 32 KiB minimum. Invalid,
unsupported, or failed parser setup and parsing reject with the source-scoped
`OKF_SOURCE_PARSE_FAILED` error; syntax errors remain
`OKF_SOURCE_SYNTAX_INVALID`.

### Module interfaces

For TS and JS, OKF extracts static imports, literal dynamic imports, literal
`require` calls, ESM and CommonJS exports, re-exports, and public members of
exported classes. Relative imports resolve through exact files, supported
extensions, and `index.*` candidates. Unresolved relative imports retain a
`null` target; package, alias, absolute, and Node built-in specifiers are
external. JSON and unsupported text do not receive module interfaces.

### Model calls

Each cache miss makes exactly three sequential, tool-free plain-text
completions at temperature zero.

**1. Analysis.** The collision-safe Markdown request contains Path, Type, an
extracted Module Interface when available, and the exact raw Content. Content
framing records its UTF-8 byte length and terminal-newline state; valid JSON
uses a `json` fence, while every other file uses `text`.

> Every readable source body, including values that may be sensitive, is sent
> unchanged to the caller-configured provider. Callers are responsible for
> selecting a provider and repository scope appropriate for that disclosure.

The trimmed, non-empty Markdown analysis must not begin with YAML frontmatter.

The second and third calls each receive only a human-readable
`# Source Summary` Markdown document containing that analysis in a
collision-safe fence. They receive no source path, type, interface, or raw
content.

**2. Description.** The prompt asks for one trimmed sentence of 1 to 240
characters ending in `.`, `!`, or `?`. At runtime, OKF accepts every non-empty
trimmed description returned by the provider and preserves its length,
punctuation, sentence count, and internal newlines without normalization,
truncation, or repair.

**3. Tags.** The prompt guides the model toward concise tags, while runtime
acceptance permits every non-empty trimmed response. Recognized formats are:

- newline-separated plain text;
- conditionally comma-separated plain text with an optional leading `Tags:`;
- a JSON string array;
- an ordinary JSON object containing only a `tags` string array;
- one complete matching Markdown fence containing one of those forms.

Plain-text items may have one whitespace-delimited bullet or decimal-list
prefix and one matching pair of single quotes, double quotes, or backticks
removed. Recognized items preserve case, punctuation, order, duplicates, and
count; they are otherwise only trimmed and empty separators are dropped. A
single unlabelled line is comma-separated only when every comma candidate
lacks `.`, `?`, and `!`. Malformed or unsupported JSON, non-string JSON items,
extra object keys, mismatched or partial fences, content outside a fence, and
any recognized form with no remaining items fall back to one tag containing
the original trimmed response.

No call requests structured output or injects a response schema.

### Logging

OKF owns its failure sanitization: its completion boundary discards provider
diagnostics and causes before reporting a failed generation stage. Injected
providers own their logging; callers handling private source should configure
a disabled logger, as the repository's OKF runner does.

### Concepts and progress

Concepts persist the first call's Markdown as `analysis`, plus the
description and tags from the later calls. YAML serialization preserves the
complete trimmed description, including internal newlines. The generated
project index folds description whitespace to single spaces only for its
one-line tree entries; it does not alter concept metadata.

Cache hits make zero provider calls. Failure in any stage prevents later
calls and concept writing. Progress observers receive summary, description,
and tags start/complete events between cache miss and the terminal generated
event. Complete events are emitted only after the corresponding local result
is valid.

## Failure contract

Known operational failures reject with the exported, non-constructible
`OkfError`. Genuine instances naturally support `instanceof`, but hosts must
use the exported `isOkfError(value)` guard as the sole trust check before
logging. The closed `code` and `stage`, fixed `message` and `hint`, and
optional normalized repository-relative `source` are package-curated and safe
for host logging. For example:

- invalid supported syntax identifies the source and syntax stage;
- failure to initialize or run the supported-source parser identifies the
  source and parse stage;
- empty model output identifies the summary, description, or tags stage.

These errors never retain a caught value or cause. The guard uses a
package-private authenticity brand, so prototype-forged and field-shaped
values are not trusted.

Cancellation remains a sanitized `AbortError`, and an exception thrown by a
progress observer retains its identity. Failures outside a known operational
boundary may escape unchanged, so hosts must render unknown failures with a
fixed message rather than inspecting them. Error details never include
absolute or filesystem paths, provider or filesystem diagnostics, source
bodies, prompts, model responses, credentials, or caught messages, names,
stacks, codes, or causes.

## Cache and prompt variants

The concept `hash` identifies the complete generation recipe:

- raw-source hash, normalized path and type, and sorted extracted
  relationships;
- parser/extractor, concept-schema, YAML, and plain-text validator versions;
- an explicit three-stage pipeline version;
- the prompt target and all three exact loaded prompts;
- provider ID, model, and effort.

Concepts generated by an earlier pipeline recipe are cache misses. Plain-text
validation is represented by `plain-text-fields-v4`, so concepts produced
under earlier description or tag validation contracts are invalidated. Cache
reads parse YAML and compare that scalar exactly. Supported files are still
parsed on cache hits, and relationship changes invalidate the cache. The
parser recipe also records the next-power-of-two buffer policy, so concepts
created with the earlier fixed buffer are cache misses.

The three system prompts live at:

```text
prompts/summarize/<target>/SYSTEM_PROMPT.md
prompts/describe/<target>/SYSTEM_PROMPT.md
prompts/tags/<target>/SYSTEM_PROMPT.md
```

Omitting `promptTarget` selects `default`. Additional targets use the same
three-file layout under their own target directory; OKF does not fall back
when a selected target is missing.

## Repository runner

```console
npm run okf -- <model-id>
```

The runner generates this repository's bundle at `.agents/bundles/project`
with the OpenAI Responses-compatible provider. Its default base URL is
`http://localhost:1234/v1`; set `OKF_BASE_URL` for another Responses endpoint
and `OKF_API_KEY` when it requires authentication. The former LM Studio
native adapter has been removed.

## Development

```console
npx nx build okf
npx nx typecheck okf
npx nx test okf
```
