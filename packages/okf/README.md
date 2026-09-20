# OKF package

`okf` generates a local Open Knowledge Format bundle for a repository. It
discovers the complete regular-file snapshot, respects scoped `.gitignore`
rules and caller-provided ignores, excludes symbolic links and binary content,
and processes every remaining readable text file in bounded concurrent
batches.

## API

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

`generate(config, root, output?)` requires an injected `LlmProvider` and model.
The optional configuration fields are `effort`, `promptTarget`, `batchSize`,
`ignore`, and `signal`. The default output is
`<root>/.agents/bundles/project`. An explicit absolute or root-relative output
must be a child of `<root>/.agents/bundles`, including after existing symbolic
links and junctions are resolved.

The result reports canonical root, output, and index paths; represented source
paths; and generated versus cache-hit counts. Concepts mirror source paths
without colliding with reserved `index.md` or `log.md` names. The root
`index.md` is regenerated deterministically.

## Processing contract

The YAML `type` is the lowercase final extension, or `no-extension`. Tree-sitter
strictly validates these extensions:

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

For TS and JS, OKF extracts static imports, literal dynamic imports, literal
`require` calls, ESM and CommonJS exports, re-exports, and public members of
exported classes. Relative imports resolve through exact files, supported
extensions, and `index.*` candidates. Unresolved relative imports retain a
`null` target; package, alias, absolute, and Node built-in specifiers are
external. JSON and unsupported text do not receive module interfaces.

Each cache miss makes exactly three sequential, tool-free plain-text
completions at temperature zero. The first is an analysis call whose collision-safe
Markdown request contains Path, Type, an
extracted Module Interface when available, and the exact raw Content. Content
framing records its UTF-8 byte length and terminal-newline state; valid JSON
uses a `json` fence, while every other file uses `text`. This means every
readable source body, including values that may be sensitive, is sent unchanged
to the caller-configured provider. Callers are responsible for selecting a
provider and repository scope appropriate for that disclosure. The trimmed,
non-empty Markdown analysis must not begin with YAML frontmatter.

The second and third calls each receive only a human-readable
`# Source Summary` Markdown document containing that analysis in a
collision-safe fence. They receive no source path, type, interface, or raw
content. The second returns one trimmed sentence of 1 to 240 characters ending
in `.`, `!`, or `?` as prompt guidance. At runtime, OKF accepts every non-empty
trimmed description returned by the provider and preserves its length,
punctuation, sentence count, and internal newlines without normalization,
truncation, or repair. The third prompt guides the model toward concise tags,
while runtime acceptance permits every non-empty trimmed response. Recognized
formats are newline-separated plain text, conditionally comma-separated plain
text with an optional leading `Tags:`, a JSON string array, an ordinary JSON
object containing only a `tags` string array, or one complete matching
Markdown fence containing one of those forms. Plain-text items may have one
whitespace-delimited bullet or decimal-list prefix and one matching pair of
single quotes, double quotes, or backticks removed.

Recognized items preserve case, punctuation, order, duplicates, and count;
they are otherwise only trimmed and empty separators are dropped. A single
unlabelled line is comma-separated only when every comma candidate lacks `.`,
`?`, and `!`. Malformed or unsupported JSON, non-string JSON items, extra
object keys, mismatched or partial fences, content outside a fence, and any
recognized form with no remaining items fall back to one tag containing the
original trimmed response. No call requests structured output or injects a
response schema.
OKF owns its failure sanitization: its completion boundary discards provider
diagnostics and causes before reporting a failed generation stage. Injected
providers own their logging; callers handling private source should configure
a disabled logger, as the repository's OKF runner does.

Concepts persist the first call's Markdown as `analysis`, plus the description
and tags from the later calls. YAML serialization preserves the complete
trimmed description, including internal newlines. The generated project index
folds description whitespace to single spaces only for its one-line tree
entries; it does not alter concept metadata. Cache hits make zero provider
calls. Failure in any stage prevents later calls and concept writing. Progress
observers receive summary, description, and tags start/complete events between
cache miss and the terminal generated event. Complete events are emitted only
after the corresponding local result is valid.

## Failure contract

Known operational failures reject with the exported, non-constructible
`OkfError`. Genuine instances naturally support `instanceof`, but hosts must
use the exported `isOkfError(value)` guard as the sole trust check before
logging the closed
`code` and `stage`, fixed `message` and `hint`, and optional normalized
repository-relative `source` are package-curated and safe for host logging.
For example, invalid supported syntax identifies the source and syntax stage;
failure to initialize or run the supported-source parser identifies the source
and parse stage; empty model output identifies the summary or description
stage; and empty model output identifies tags. These errors never retain a
caught value or cause.
The guard uses a package-private authenticity brand, so prototype-forged and
field-shaped values are not trusted.

Cancellation remains a sanitized `AbortError`, and an exception thrown by a
progress observer retains its identity. Failures outside a known operational
boundary may escape unchanged, so hosts must render unknown failures with a
fixed message rather than inspecting them. Error details never include
absolute or filesystem paths, provider or filesystem diagnostics, source
bodies, prompts, model responses, credentials, or caught messages, names,
stacks, codes, or causes.

## Cache and prompt variants

The concept `hash` identifies the complete generation recipe: raw-source hash,
normalized path and type, sorted extracted relationships, parser/extractor,
concept-schema, YAML, and plain-text validator versions, an explicit
three-stage pipeline version, prompt target and all three exact loaded prompts,
provider ID, model, and effort. Concepts generated by an earlier pipeline
recipe are cache misses. Plain-text validation is represented by
`plain-text-fields-v4`, so concepts produced under earlier description or tag
validation contracts are invalidated. Cache reads parse YAML and compare that
scalar exactly. Supported files are still parsed on cache hits, and
relationship changes invalidate the cache. The parser recipe also records the
next-power-of-two buffer policy, so concepts created with the earlier fixed
buffer are cache misses.

The three system prompts live at:

```text
prompts/summarize/<target>/SYSTEM_PROMPT.md
prompts/describe/<target>/SYSTEM_PROMPT.md
prompts/tags/<target>/SYSTEM_PROMPT.md
```

Omitting `promptTarget` selects `default`. Additional targets use the same
three-file layout under their own target directory; OKF does not fall back when
a selected target is missing.

## Development

```console
npx nx build okf
npx nx typecheck okf
npx nx test okf
```
