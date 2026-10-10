# Web bundle

`web` contains the web research capability Doric exposes to its agent. Its
build writes `bundles/web/dist`; the Direct host loads it through the `bundle`
loader.

## Capabilities

- The always-available `web` tool searches the web, opens HTTP(S) pages as
  extracted text, or finds literal text in a page. It runs in the host process
  with its own `fetch`; it never touches the sandbox.
- The `web-research` skill describes the search-open-find workflow.

Both keep their global model-visible positions (`order` 700 for the tool and
1200 for the skill), so moving them out of `files` changes neither the tool
list nor the system prompt.

## Development

```console
npx nx build bundle-web
npx nx typecheck bundle-web
npx nx test bundle-web
```
