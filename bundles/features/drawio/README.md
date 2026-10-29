# drawio bundle

**Diagrams the agent draws and you review, right inside the conversation.**

The drawio bundle lets a Doric agent publish a draw.io diagram as a node of the
conversation. You see each page, pin comments on its shapes and connectors, and
the agent answers them with a new revision next to the old one. Everything runs
offline, on the draw.io webapp Doric ships with.

It is a feature bundle with a host part (the `diagram` kind, the tool and the
`drawio.diagrams/v1` service that reads, saves and exports diagrams), a desktopMain part (the drawing cache and the comment flush) and a
client part (the node and its Revisar and Editar modal), loaded by the `bundle` platform.
See the [main README](../../../README.md) for Doric as a whole and the
[feature doc](../../../docs/features/threads-drawio-diagrams.md) for its
decisions.

Version 1.2.0 reviews, edits and exports diagrams: the modal's Editar mode
opens the draw.io editor, each save is a new revision, and Salvar no Project
writes the revision to the Project as `.drawio` and `.drawio.svg`.

## How it works

1. The agent writes an uncompressed draw.io file (`mxfile`) anywhere in the
   Project (the skill's convention is `.doric/artifacts/drafts/`) and calls
   `drawio_diagram` with its `path`. The tool refuses only a path outside the
   Project or inside `.doric/artifacts/<artifact_id>/`.
2. The tool normalizes it (`normalizeDiagram`: at most 2 MiB, 50 pages and
   5,000 cells) and publishes it as an artifact of kind `diagram`, with one
   entry, `diagram.drawio`.
3. The `<drawio-diagram>` node draws the page and lets you comment on it.
4. The next send carries your comments to the agent; it answers each with
   `comment_reply` and publishes the next revision.

The `diagram` kind is exempt from the review policy
(`artifacts.review-policy/v1` `exemptKinds`, default `['diagram']`): it always
runs under `proceed`, and its frame never shows Autorizar.

## Agent tool

`drawio_diagram` (order 1750, always available), with the
`drawio-diagram` skill (order 3410) telling the agent how to use it:

- **Create:** `path` and `title` (and optional `notes`).
- **Revise:** `artifact_id`, `path` and `base_revision`, the revision the
  draft holds. When a newer revision exists the call is refused and lists the
  newer revisions, so the agent checks out the latest and reapplies its
  changes.
- **Checkout:** `artifact_id`, `path` and `checkout: true` write the latest
  revision to a new file and publish nothing.

It returns the revision, the pages and the unresolved comments with their
anchors and replies. Cell ids should stay stable across revisions: comments
are anchored to them.

## The node

- The page is drawn by a hidden renderer (`@drawio/react`), one page per export,
  then sanitized and measured in a sandboxed frame. The sanitizer drops
  scripts, frames, `on*` attributes, every `href`/`xlink:href` that does not
  start with `#` or `data:image/` (so links stay dead), and any
  `foreignObject` holding media, form controls, `link` or `meta`; a text-only
  `foreignObject` stays.
- The node shows the page as an `<img>` with comment pins, `pág P/N` under the
  header when there is more than one page, Comentar and Expandir. Expandir
  works without a Thread.
- Without a sandbox lease, the node shows the cached drawing without Comentar
  or Expandir, with the line "O Project está sem sandbox ativo" (plus Tentar
  de novo when nothing is cached).
- Anchors are a cell (`page/<p>/cell/<id>`) or a point of a page
  (`page/<p>/point/<x>,<y>`), re-anchored on each revision. A comment on
  another page shows as a detached pin. A cell changed since its comment gets
  the bundle's own dashed outline (`ChangedCells`), titled "A célula mudou
  desde o comentário".

## The Revisar modal

Expandir opens the revision in the canvas modal, with:

- page and revision menus (only with more than one of each);
- the toolbar: Selecionar (`V`), Comentar (`C`), Mão (`H`), zoom out / in,
  100%, Ajustar;
- keys `Cmd/Ctrl+=` or `+` (zoom in), `Cmd/Ctrl+-` (zoom out),
  `Cmd/Ctrl+0` (100%) and `Shift+1` (fit), never taken from text fields;
- comments on cells of any page;
- Enviar ao agente (n) while there are comment drafts, which sends them
  through `chat.send/v1`.

Pins inside the diagram open their thread popover. The node and the modal do
not answer chat's `doric:comment-thread-open` event yet, so clicking a
diagram comment in the conversation does not open its thread in the diagram.

## The Editar mode

Editar (`E`) swaps the canvas for the draw.io editor in an iframe, under the
modal's own header with the title and `rev B`. It is disabled when the
revision's XML was not read, or when there is no Thread scope to save under.

- `CmdOrCtrl+S` and the editor's own save shortcut save through
  `drawio.diagrams/v1.save`; autosave only keeps the XML in memory.
- While loading, saving or unavailable the modal says so; unavailable offers
  Tentar de novo and Voltar. A heartbeat and a load deadline catch an editor
  that stops answering.
- Banners report a restarted editor, a failed save (naming a missing sandbox
  lease) and a new revision published while you edit, which
  `runtime.threads/v1` feeds; saving still writes the next revision.
- Leaving with unsaved changes asks "Salvar as alterações?" with Salvar,
  Descartar and Continuar editando.

A save made from the window carries no `promptId`, so the revision is
attributed to the prompt that created the diagram.

## Export

In Revisar, `Salvar no Project` (after `Editar`, disabled without the
revision's XML or a Thread scope) opens a dialog over the modal's panel:

- The `Caminho` field starts at `docs/diagrams/<slug>`, the title
  transliterated ("Ação de Pedido" gives `docs/diagrams/acao-de-pedido`;
  `diagrama` when nothing is left). A hint says the `.drawio.svg` holds only
  page 1; the `.drawio` holds every page.
- Salvar draws page 1 as `xmlsvg` and calls `drawio.diagrams/v1.export` with
  `overwrite: false`. Written files close the dialog with the toast
  "Gravado em <caminho>.drawio e .drawio.svg".
- When a file exists as a regular file, the dialog lists it and offers
  Substituir next to Salvar; Substituir sends the same SVG with
  `overwrite: true`. Editing the path then clears the file list and hides
  Substituir.
- A folder, link or special entry at a file's path, or a path prefix that is
  not a folder, is never replaced: the dialog names it, without Substituir.
- A failed drawing shows "O diagrama não pôde ser desenhado"; without a
  sandbox, "O Project está sem sandbox ativo; tente de novo quando ele voltar";
  any other rejection, "Não foi possível salvar no Project: <message>", with
  the host's English message.
- Esc, the dialog's backdrop and Cancelar close only the dialog, and do nothing
  while an answer is pending; the modal does not close while the dialog is
  open.

The host refuses an empty path, one over 512 characters, starting with `/`,
with an empty, `.` or `..` segment, inside `.doric/` (first segment `.doric`;
`.doric-notes/x` is allowed), or ending in
`.drawio` or `.drawio.svg`. It checks the folders and files with `test`
commands, never `getFile`, writes the `.drawio` and then the `.drawio.svg`, and
removes the `.drawio` again when the second write fails.

## Contracts

| Contract             | Part        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drawio.diagrams/v1` | host        | `read`: a diagram's stored XML; `save`: `{ artifactId, xml }` → `{ revision, revisions, sha256 }`, always a new revision noted "Editado pelo usuário" unless the normalized XML equals the latest (then the latest returns); `export`: `{ artifactId, revision, path, svg, overwrite }` → `written { files }`, `exists { files }` or `blocked { path, reason: directory \| special \| not-a-folder }`; errors `invalid_input`, `not_found`, `unavailable` (`details.lease`), and `internal` for a failed check or write in `export`. Version 1.2.0, exposed to the desktop |
| `drawio.svg/v1`      | desktopMain | `get`, `put`: drawn pages by revision, entry hash, page and theme; `status`: `doric.drawio/v1.describe`, whether the editor origin is available                                                                                                                                                                                                                                                                                                                                                                                                                            |

The SVG cache lives under the bundle's `doric.cache/v1` directory, in
`svg/<artifactId>@<revision>/<sha256>/`, with a `first-page.json` pointer per
revision so a `get` without `pageId` answers with the first page. Comment
drafts flush through the `drawio-diagram` kind of `chat.composer/v1`.

The bundle requires `artifacts/v1@^1.1.0`, `artifact.kind/v1`, `comments/v1`,
`tools/v1`, `ui/v1`, `runtime.lease/v1` and `runtime.workspace/v1`, and uses
`chat.composer/v1`, `chat.send/v1` and `runtime.threads/v1` when present:
the composer holds the comment drafts, `chat.send/v1` sends them for
Enviar ao agente (n), and without them commenting is unavailable.
