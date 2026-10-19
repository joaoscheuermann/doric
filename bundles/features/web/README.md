# Web bundle

`web` lets the Doric agent look things up beyond the Project: it can search
the web, open a page as readable text and find exact text in it, so answers
about current libraries, APIs or documentation rest on what the source
actually says.

It is a small feature bundle with a host part only, loaded by the `bundle`
platform. See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Tool:** `web`, always available, with three actions:
  - `search` — search the web (through DuckDuckGo's HTML endpoint), 5 results
    by default and at most 10;
  - `open_page` — open an HTTP(S) page as extracted text, 12,000 characters by
    default and at most 50,000;
  - `find_in_page` — find literal text in a page, 20 matches by default and at
    most 100.
- **Skill:** `web-research`, the search-open-find workflow.

The bundle provides no contract of its own.

## How it works

The tool runs in the host process with its own `fetch` and a 20 s request
timeout; it never touches the sandbox.

The tool and the skill keep their global model-visible positions (`order` 700
for the tool, between `tree` and `write`, and 1200 for the skill), so moving
them out of `files` changed neither the tool list nor the system prompt.

## Development

```console
npx nx build bundle-web
npx nx typecheck bundle-web
npx nx test bundle-web
```

The build writes `bundles/features/web/dist`; the Doric host loads it through
the `bundle` loader. To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
