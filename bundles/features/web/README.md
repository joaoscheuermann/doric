# web

`web` lets the Doric agent read the public web. It registers one tool, `web`,
that searches the web, opens an HTTP(S) page as extracted text and finds
literal text in a page, and it ships the skill `web-research`, which tells the
agent when and how to use that tool. The feature as a whole, across bundles, is
described in [Web research](../../../docs/features/web-research.md); how
bundle skill files are built and registered is described in
[Skills](../../../docs/features/skills.md).

## Manifest

| Field             | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| `manifestVersion` | `1`                                                      |
| `id`              | `web`                                                    |
| `version`         | `1.0.0`                                                  |
| `engines`         | `doric` `^1.0.0`                                         |
| `description`     | `Web research capability for the Doric agent.`           |
| `provides`        | none                                                     |
| `requires`        | `tools/v1@^1.5.0`                                        |
| `optional`        | `log/v1`, `secrets/v1`                                   |
| Parts             | host (`src/host/`), and the skill files of `src/skills/` |

([manifest.json](manifest.json), [project.json](project.json))

## Contracts

### Provided

None. The contracts module exports nothing
([src/contracts/index.ts](src/contracts/index.ts)); the package exports it as
`web/contracts` and exports nothing else besides `web/package.json`
([package.json](package.json)). Other bundles reach the tool only through the
`tools/v1` catalog.

### Used

- `tools/v1` (from `bundle/contracts`, provided by the
  [`core` bundle](../../foundation/core/README.md)): the host part calls
  `register(tool, { alwaysAvailable: true, order: 700 })` once during
  `activate` ([src/host/index.ts](src/host/index.ts)). The range is `^1.2.0`
  because the `order` option exists from 1.2.0
  ([packages/bundle/src/contracts/basic/tools.ts](../../../packages/bundle/src/contracts/basic/tools.ts)).
  `tools/v1` lists tools by `order`, then by registration, so 700 places `web`
  between the [`files` bundle](../files/README.md)'s `tree` (600) and `write`
  (800) ([bundles/features/files/src/host/index.ts](../files/src/host/index.ts),
  [docs/features/files.md](../../../docs/features/files.md)).
- `skills/v1`: the bundle's own code never calls it. The bundle loader
  registers the skill files on the bundle's behalf, once every host bundle of
  the activation phase has activated, so that `allowed-tools` resolves against
  the whole tool catalog; the loader fails the bundle's activation with
  `missing_dependency` when no `skills/v1` provider is active
  ([packages/bundle/src/loader/activate.ts](../../../packages/bundle/src/loader/activate.ts),
  [packages/bundle/src/process/runner-main.ts](../../../packages/bundle/src/process/runner-main.ts)).

## Parts

### Host part

`activate({ services })` registers the tool that `createTool()` returns, with
no options, so it uses the global `fetch` and a 20 s timeout
([src/host/index.ts](src/host/index.ts)). The part registers nothing else and
returns nothing to dispose.

### Process entry (S50a)

The bundle also has a process entry, [`src/host/main.ts`](src/host/main.ts),
built to `dist/host/main.mjs`, for the bundle-process runtime
([bundle processes](../../../docs/features/bundle-processes.md)). It calls
`runBundle` with `ToolHandlerService` listed statically. At activation
`registerWebTool` ([src/host/part.ts](src/host/part.ts)) registers the `web`
tool, defined with `Deps = unknown` and bound with `bind(undefined)`, with
`tools/v1` (`alwaysAvailable`, order 700). Provider rejections pass through
unchanged. The kernel entry stays until S62; since S62c1 the
manifest requires `tools/v1@^1.5.0`.

The host part runs in the generation process the Doric host forks: `web` is an
installed bundle that the host's composition enables and does not list as
`resident`
([app/backend/doric-host/composition.json](../../../app/backend/doric-host/composition.json),
[packages/bundle/src/process/partition.ts](../../../packages/bundle/src/process/partition.ts)).

### Skill files

`src/skills/web-research/SKILL.md` is the skill `web-research`
([src/skills/web-research/SKILL.md](src/skills/web-research/SKILL.md)):

- frontmatter: `name: web-research`, `allowed-tools: [web]`, `order: 1200`, no
  `alwaysAvailable`, so it is registered as not always available
  ([packages/bundle/src/loader/activate.ts](../../../packages/bundle/src/loader/activate.ts));
- description: it finds and inspects current or externally hosted information
  through a search-open-find workflow, for goals that depend on facts or
  documentation not present in the workspace or the supplied context;
- body: sections Purpose, Use this skill when, Do not use this skill when,
  Procedure and Completion. The procedure is: define the fact to find;
  `search` with a focused query, preferring official or primary sources; open
  the relevant pages rather than trusting titles or snippets; use
  `find_in_page` for exact terms, versions, clauses or headings; check date,
  scope and version and compare independent sources when a fact is uncertain;
  keep the source's title, URL and supporting passage, apart from inference;
  narrow the query or the page range when output is truncated.

`skills/v1` rejects a skill whose `allowed-tools` names a tool missing from the
catalog with `unavailable_tool`
([bundles/foundation/core/src/host/skills.ts](../../foundation/core/src/host/skills.ts)).

## The `web` tool

Defined with `defineTool` of the `tool` package in
[src/host/tools/web.ts](src/host/tools/web.ts).

- Name: `web`.
- Description: `Search the web, open HTTP(S) pages as extracted text, or find literal text in a page.`

### Input

A strict object; the tool-call layer rejects a payload that fails it, unknown
keys included, with a `ToolErrorObject` of code `invalid_payload` before the
tool runs ([packages/tool/src/lib/tools.ts](../../../packages/tool/src/lib/tools.ts)).

| Field        | Type                                        | Used by                     |
| ------------ | ------------------------------------------- | --------------------------- |
| `action`     | `'search' \| 'open_page' \| 'find_in_page'` | all                         |
| `query`      | string, optional                            | `search`                    |
| `url`        | string, optional                            | `open_page`, `find_in_page` |
| `pattern`    | string, optional                            | `find_in_page`              |
| `ignoreCase` | boolean, optional, default `true`           | `find_in_page`              |
| `limit`      | non-negative integer, optional              | `search`, `find_in_page`    |
| `maxChars`   | non-negative integer, optional              | `open_page`                 |

A field an action does not use is ignored.

### Output

A strict object, the same shape for every action:

```ts
{
  action: string;        // the action run
  detail: string;        // what was asked, per action; '' on error
  results: { title: string; url: string; snippet: string }[]; // search only
  page?: { url: string; title: string; text: string };        // open_page only
  matches: { line: number; text: string }[];                  // find_in_page only
  total: number;
  truncated: boolean;
  error?: string;        // set only on failure
}
```

The tool-call layer checks each return against this schema and fails a
non-matching one with a `ToolErrorObject` of code `invalid_output`
([packages/tool/src/lib/tools.ts](../../../packages/tool/src/lib/tools.ts)).

`src/host/tools/web.ts` exports `createTool`, the schemas `input` and
`output`, and the types `WebSearchResult`, `WebPageOutput`, `WebFindMatch` and
`WebOutput` for these shapes; the package exports none of them.

### `search`

1. Trims `query`; an absent or empty query fails with
   `Missing query for search`.
2. Clamps `limit` (default 5) to 1–10.
3. Fetches `https://duckduckgo.com/html/?q=<query>`.
4. Reads every `<a>` whose quoted `class` attribute contains `result__a` and
   comes before its `href` as a result (its `href` and its content as title),
   and every `<a>` whose quoted `class` attribute contains `result__snippet`
   as a snippet; a result `<a>` whose `href` comes before its `class` is not read; the n-th snippet belongs to the n-th
   result, and a result with no snippet gets `''`. Titles and snippets are
   cleaned: tags removed, entities decoded, whitespace collapsed and trimmed.
5. Normalizes each URL: a protocol-relative URL gets `https:`; a URL with a
   `uddg` query parameter (a DuckDuckGo redirect) becomes that parameter's
   value; an unparsable URL stays as written. A result whose URL is empty is
   dropped.
6. Returns the first `limit` results; `total` is the number of results kept
   before the limit, `truncated` is `total > limit`, and `detail` is the query.

([src/host/tools/web.ts](src/host/tools/web.ts), [tests/web.test.ts](tests/web.test.ts))

### `open_page`

1. Accepts `url` only when it trims to a URL that parses with protocol `http:`
   or `https:`; otherwise fails with `Missing or invalid URL for open_page`.
2. Clamps `maxChars` (default 12,000) to 1–50,000.
3. Fetches the normalized URL, reading the whole body; redirects follow
   `fetch`'s default.
4. Returns `page` with `url` (the requested URL, normalized, not the final one
   after redirects), `title` and `text` cut to `maxChars`; `truncated` says
   whether the text was cut, `total` is 1 and `detail` is the URL.

([src/host/tools/web.ts](src/host/tools/web.ts), [tests/web.test.ts](tests/web.test.ts))

### `find_in_page`

1. Validates `url` as `open_page` does; otherwise fails with
   `Missing or invalid URL for find_in_page`.
2. Trims `pattern`; an absent or empty pattern fails with
   `Missing pattern for find_in_page`.
3. Clamps `limit` (default 20) to 1–100 and fetches the page.
4. Splits the page's extracted text into lines and keeps each line that
   contains the pattern literally, comparing lower-cased text unless
   `ignoreCase` is `false`. Each match is `{ line, text }`, with the 1-based
   line number in the extracted text and the line's text.
5. Stops at the first matching line past the limit: `truncated` is then
   `true` and `total` is `limit + 1`; otherwise `truncated` is `false` and
   `total` is the number of matching lines. `detail` is `'<pattern>' in <url>`.

([src/host/tools/web.ts](src/host/tools/web.ts), [tests/web.test.ts](tests/web.test.ts))

### Title and text extraction

- Title: the content of the first `<title>` element, cleaned as search titles
  are; `''` when there is none.
- Text, in order: drop the `<head>` element; drop every `script`, `style` and
  `noscript` element; turn `<br>` and `<br/>` without attributes and the
  closing tags of `p`, `div`, `li`, `h1`–`h6` and `tr` into line breaks;
  replace every remaining tag, a `<br>` with attributes included, with a
  space; decode entities; trim each line, collapse each run of two or more
  spaces or tabs to one space and drop empty lines; remove all whitespace, line breaks included,
  before `.`, `,`, `;`, `:`, `!` and `?`; collapse three or more line breaks
  to two; trim.
- Entities decoded: decimal numeric references (`&#123;`), hexadecimal ones
  with a lowercase `x` (`&#x7b;`), and `&amp;`, `&lt;`, `&gt;`, `&quot;`,
  `&apos;`, `&#39;` and `&nbsp;`, which becomes a plain space (U+0020); any
  other entity, `&#X7b;` included, stays as written.

([src/host/tools/web.ts](src/host/tools/web.ts), [tests/web.test.ts](tests/web.test.ts))

## Side effects

Each call that passes its argument checks makes exactly one HTTP GET request
through the host process's `fetch`, with a desktop Chrome `user-agent` header,
to DuckDuckGo for `search` and to the given URL for the other two; a call that
fails them makes none. The request, reading of the body included, is aborted
after 20 seconds; it is not tied to the prompt's abort signal. The tool never touches
the Project's sandbox or files
([src/host/tools/web.ts](src/host/tools/web.ts)).

## Data and persistence

None: the bundle stores nothing and keeps no state between calls.

## Configuration

None at run time: the bundle reads no setting, environment variable or secret.
`createTool(options)` takes `fetch` (a replacement for the global `fetch`) and
`requestTimeoutMs` (default 20,000, raised to at least 1), which only the tests
pass ([src/host/tools/web.ts](src/host/tools/web.ts),
[tests/web.test.ts](tests/web.test.ts)).

## Limits

| Limit                            | Default | Range    |
| -------------------------------- | ------- | -------- |
| `search` results (`limit`)       | 5       | 1–10     |
| `find_in_page` matches (`limit`) | 20      | 1–100    |
| `open_page` text (`maxChars`)    | 12,000  | 1–50,000 |
| Request timeout                  | 20 s    | —        |

The response body is read whole, with no size limit; `maxChars` applies only
to the extracted text ([src/host/tools/web.ts](src/host/tools/web.ts)).

## Errors and failure behavior

### At activation

Each of these fails the bundle's activation. `duplicate_tool` is the code of
the `ContractError` that `activate` throws; the other three are the codes of
the loader's `ActivationFailure`
([packages/bundle/src/loader/activate.ts](../../../packages/bundle/src/loader/activate.ts),
[bundles/foundation/core/src/host/tools.ts](../../foundation/core/src/host/tools.ts)).
The activation loop quarantines the bundle with `registration_failed` for `duplicate_tool`, and with the listed code for the other three; a skill failure comes after the phase and also withdraws the `web` tool ([packages/bundle/src/runtime/activation.ts](../../../packages/bundle/src/runtime/activation.ts)).

| Code                  | When                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `duplicate_tool`      | `tools/v1.register` throws it when another bundle in the same generation view already registered a tool named `web` |
| `missing_dependency`  | the bundle has a skill file and no `skills/v1` provider is active                                                   |
| `skill_invalid`       | a skill file cannot be read or parsed                                                                               |
| `registration_failed` | `skills/v1` rejects the skill, `unavailable_tool` included                                                          |

### During a call

A missing argument or a failed request is returned as output, not thrown:
`error` holds the message, `detail` is `''`, `results` and `matches` are empty,
`page` is absent, `total` is 0 and `truncated` is `false`
([src/host/tools/web.ts](src/host/tools/web.ts),
[tests/activate.test.ts](tests/activate.test.ts)).

| Message                                   | When                                           |
| ----------------------------------------- | ---------------------------------------------- |
| `Missing query for search`                | `query` absent or blank                        |
| `Missing or invalid URL for open_page`    | `url` absent, blank, unparsable or not HTTP(S) |
| `Missing or invalid URL for find_in_page` | the same, for `find_in_page`                   |
| `Missing pattern for find_in_page`        | `pattern` absent or blank                      |
| `Request returned HTTP <status>`          | the response is not OK                         |
| `Request failed: timed out after <ms>ms`  | the request was aborted by the timeout         |
| `Request failed: <message>`               | any other `fetch` failure                      |

A numeric entity above the last Unicode code point (such as `&#9999999;`) in
decoded text makes the tool throw a `RangeError`, which the tool-call layer
turns into a `ToolErrorObject` of code `handler_failed`
([src/host/tools/web.ts](src/host/tools/web.ts),
[packages/tool/src/lib/tools.ts](../../../packages/tool/src/lib/tools.ts)).

## Build and test

Run from the repository root:

```console
npx nx run bundle-web:typecheck
npx nx run bundle-web:test
npx nx run bundle-web:build
```

- `build` compiles `src/` to `dist/` with `tsc`, then runs the bundle build:
  it validates `manifest.json` and copies it to `dist/`, checks each skill file
  and copies it to `dist/skills/<folder>/SKILL.md`, imports
  `dist/host/index.js` and dry-activates it, failing when the part provides or
  defines a contract missing from `provides`, and writes the JSON Schemas,
  `contracts.json` and `package.json` into `dist/`
  ([project.json](project.json),
  [packages/bundle/src/build/cli.ts](../../../packages/bundle/src/build/cli.ts),
  [packages/bundle/src/build/record.ts](../../../packages/bundle/src/build/record.ts)).
- `test` compiles `src/` and `tests/` to `dist-tests/` and runs
  `dist-tests/tests/*.test.js` with `node --test`
  ([project.json](project.json)).
  [tests/web.test.ts](tests/web.test.ts) tests the tool with a fake `fetch`;
  [tests/activate.test.ts](tests/activate.test.ts) activates the host part
  over a recording `tools/v1` from
  [tests/support/services.ts](tests/support/services.ts) and checks the
  skill's frontmatter.

`npx nx run doric-host:build-bundles` rebuilds and stages every bundle the
Doric host loads ([app/backend/doric-host/project.json](../../../app/backend/doric-host/project.json)).
