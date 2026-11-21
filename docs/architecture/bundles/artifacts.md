# Artifacts

**Status:** removed on 2026-11-06, with stage 4 of OpenUI ([docs/designs/openui.md](../../designs/openui.md), [docs/designs/papercraft-openui.md](../../designs/papercraft-openui.md#d25-removal-and-persisted-data-p8-concept-q8)). The `artifacts` bundle, `artifacts/v1`, `artifact.kind/v1`, `artifacts.cache/v1`, the four events and the `artifacts.review-policy/v1` setting no longer exist; papercraft draws OpenUI Lang programs in fences of the response, with no artifact ([docs/features/papercraft.md](../../features/papercraft.md)). The `artifacts.*` rows of old Threads are replayed without a block; each workspace's `.doric/artifacts/` stays where it is, unread, and the user may delete it; the desktop's `userData/artifacts/` cache is deleted at every start. The text below remains as the historical record of the concept.

## Summary

An artifact is the **durable deliverable** the agent produces inside the app to **show, explain or prove** a change to the Project's code — the surface the conversation cannot give: a live preview, a recording, an interactive diagram. It is the agent's channel for asynchronous collaboration: instead of the user following every tool call, they look at the deliverables at milestones, and a comment on an artifact steers the agent.

Doric is **YOLO by default**: the agent does not ask permission to act. An artifact, therefore, **is not a gate** — it is a window onto the agent's work, which the user looks at, comments on and asks to adjust. Prior review exists as **a Project's choice** ([the review policy](#the-review-policy)), and not as the normal path.

Doric already has the pieces the artifact depends on — a durable event log, conversation nodes, storage, the sandbox lease, call scopes — and what is missing is the registry that gives **identity, revisions, anchors and comments** to these deliverables.

The operational definition, which the rest of the document details: an artifact has a **stable identity** (`artifactId`), immutable **revisions**, a **kind** (`kind`) declared by a provider, **anchors** in the code it touches (`targets`), one **durable event** per transition, a **node** in the conversation and **anchored comments** ([comments](./comments.md)) as review state.

## What it is and what it is not

An artifact **is**:

- a deliverable with **identity** (`artifactId`) and immutable **revisions** — revision 2 does not erase revision 1, because the node and the comments of 1 remain valid;
- a **portrait of code**: it exists for the user to see what is being done, and so it declares the anchors it touches (`targets`);
- **durable and rebuildable**: each transition is an event of the log, and replay rebuilds the whole conversation, revision by revision;
- **commentable**: anchored comments, which steer the next revision.

An artifact **is not**:

- **the change itself.** The diff applied to the code is the effect, not the artifact; the artifact shows what the change does. `artifacts.applied/v1` closes the cycle, but the Project's file remains the Project's file;
- **a plan, a summary or a diff.** These already have a home: the agent's text in the conversation and the `git` changes panel. An artifact exists only when the deliverable needs a surface the conversation does not give — that is the rule of [kinds](#the-kinds-artifactkindv1) below;
- **the provider's history.** It is the same distinct record as always ([events and nodes](./events-and-nodes.md)); the artifact is a projection of the durable log, not of the resume history;
- **a log or diagnostics.** Tracing, metrics and log files are [observability](./observability.md), not a deliverable;
- **a bundle artifact** — the sense the platform already uses, below.

## Two senses of artifact

The platform already calls something else an "artifact": the **distributed file of a bundle**, addressed by SHA-256, which the host publishes in the catalog and the desktop downloads and verifies before activating.

| Sense            | What it is                                                                                          | Where it appears today                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Bundle artifact  | A file of a bundle's package, identified by its SHA-256                                             | `doric.catalog/v1.artifact({ sha256 })` → `{ sha256, base64 }` (`packages/bundle/src/contracts/platform.ts:406-415`)           |
| Bundle artifact  | The verified copy on the desktop, written only after the hash matches                               | `ArtifactCache`, in `userData/bundles/<id>@<version>/<path>` (`app/desktop/doric/src/platform/catalog/artifacts.ts:1-5,45-70`) |
| Project artifact | The deliverable the agent produces inside the Project to show a change, with revisions and comments | This document: `/workspace/.doric/artifacts/<artifactId>/`, `artifacts.*` events, a node in the conversation                   |

The composition uses the first sense — "o host guarda bundles instalados, artefatos e composição" (`bundles.md:21`), "o desktop guarda apenas um cache verificado desses artefatos" (`composition-and-distribution.md:7`).

Rule: **on the platform, "artifact" is the unit of distribution; in the Project, it is the reviewable deliverable.** The two coexist because they live in different scopes — one is platform catalog, the other is Project state —, and the new names do not use the word alone in any contract: the registry is `artifacts/v1`, the events are `artifacts.*`, and none of them can be confused with `doric.catalog/v1`.

## Where it lives

At the **root of the Project's workspace**, which is the root of the sandbox:

```text
/workspace/.doric/
  artifacts/<artifactId>/
    artifact.json      # manifesto pequeno: identidade, tipo, revisão, âncoras, entradas
    <payload>          # o que o tipo define: index.html, …
```

Three facts of the platform fix this place:

- A Project has a single workspace, and **its Threads share it**: "Threads share their Project's sandbox; each Thread's working directory starts at the sandbox's workspace root `/workspace`" (`docs/features/cwd-tool.md`). The Thread's `cwd` is the `/workspace` default of the Thread record (`bundles/runtime/runtime/src/contracts/storage.ts:86`), and `runtime.workspace/v1` moves it to any path **inside** the workspace root (`bundles/runtime/runtime/src/contracts/workspace.ts:1-15,58-62`).
- The host reaches the workspace through the **lease**: `runtime.lease/v1.describe()` returns the identity and the **root**, and the contract has `readFile` and `writeFile` (`bundles/runtime/runtime/src/contracts/lease.ts:96-105`). It is exactly the path `files` already uses (`bundles/features/files/src/host/sandbox.ts:1-39`).
- The path guard **already exists and is not the artifact's**: the sandbox rule refuses any path that resolves outside the workspace root (`docs/features/cwd-tool.md`; `runtime.workspace/v1` returns `outside` in the `CwdChange`, `workspace.ts:15-16`).

Hence the rule: **everything Doric writes in the workspace lives under `.doric/`**, never scattered through the user's code; and what is **derived and disposable** — the compiled form of a preview, for example — stays in the **app cache**, not in the Project, because the cache belongs to the platform and the Project belongs to the user.

`artifact.json` is the index of the working copy:

```json
{
  "artifactId": "…",
  "kind": "preview",
  "title": "Checkout com o botão de pagar",
  "revision": 2,
  "targets": [{ "path": "src/checkout/Checkout.tsx", "lines": [40, 48] }],
  "entries": [{ "path": "index.html", "sha256": "…" }]
}
```

- **`.doric/` is app state in the Project, not user code.** It starts out ignored by Git; versioning an artifact is a choice, not the default. The deliverable that gets versioned is the diff of the real code; the artifact is what explains it.
- **The durable truth is the log, not the directory.** The event carries identity, kind, revision, anchors and the **entries** (`path` + `sha256`) — never the bytes. The content stays in the directory and the derived form in the app cache. Replay rebuilds the state from the log; the manifest can be regenerated, and the event's hashes verify the working copy.
- **Where the content comes from is up to the kind.** A `preview` is derived: the payload is Project code, and the compiled form is rebuilt. A kind that writes content of its own — a recording, a diagram — keeps the file in the directory, and without it the artifact appears as unavailable, with the event still naming what existed.

## Lifecycle and events

```text
created ──▶ revised ──▶ applied
               │
               └─▶ approved        (só com a política `request`)
```

| Event                   | Payload (summary)                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `artifacts.created/v1`  | `artifactId`, `revision`, `kind`, `title`, `targets`, `payload` (the kind's schema) |
| `artifacts.revised/v1`  | `artifactId`, `revision`, `kind`, `title`, `changeNote`                             |
| `artifacts.approved/v1` | `artifactId`, `revision`, `scope` — exists only with the `request` policy           |
| `artifacts.applied/v1`  | `artifactId`, `revision`, `files`                                                   |

Declared in `contracts/` with `defineEvent` and registered with `events/v1` on activation, like any event ([contracts](./contracts.md)). The sink is the `runtime`'s, with `scopeKeys` `['projectId', 'threadId', 'promptId']` on the stream `runtime.thread.events/{threadId}` (`bundles/runtime/runtime/src/contracts/events.ts:28-32`) — **there is no new sink**, and an `append` outside that scope is refused with `invalid_scope`, as [events and nodes](./events-and-nodes.md) requires.

The comment is **not** an event of the artifact: it belongs to the [comments](./comments.md) registry, which points to the revision as its target. They are two streams, and that is what lets any feature comment on anything.

A revision is **immutable**: revising publishes a new event and a new node, and the old node stays in the conversation with the comments it had. That is what lets the user compare "what I asked for" with "what came".

## The `artifacts/v1` contract

A host service provided by the `artifacts` bundle, cardinality `one` like the others. The methods a window calls declare `desktopScope` with `['projectId', 'threadId', 'promptId']` and `expose: 'desktop'`, like `resources/v1` and `screen.views/v1`.

| Method    | What it does                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `create`  | Asks the kind's provider for the materialization, writes the first revision and the manifest, and publishes `artifacts.created/v1` |
| `revise`  | Materializes the next revision on the same identity, without touching the previous one, and publishes `artifacts.revised/v1`       |
| `read`    | Returns the record (title, kind, revision, anchors) and the revision's entries `{ path, sha256, base64 }`                          |
| `list`    | Lists the Project's artifacts and, when the scope carries a Thread, that Thread's                                                  |
| `approve` | Writes `artifacts.approved/v1` with the authorized scope — called only under the `request` policy                                  |
| `apply`   | Writes `artifacts.applied/v1` when the change has been written                                                                     |

`read` returns the entries in base64 for the same reason as `doric.catalog/v1.artifact` — the envelope is JSON — and whoever writes to the cache verifies the hash before serving, as the desktop already does with bundles. The registry **reads and writes `.doric/` through the lease**, as `files` does: without a lease there is no working copy, and the service answers with a state instead of failing, like `files/v1`.

## The kinds: `artifact.kind/v1`

An artifact without a kind is a file. The **kind** is what says what the agent can ask for, what is validated, what is materialized and how it appears on screen. The contract has cardinality `many`, in the `host`: each bundle registers the kinds it owns.

| Field         | What it declares                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `id`          | The kind's name: `preview`, …                                                                      |
| `payload`     | The closed zod schema of what the agent sends on creation and on revision                          |
| `materialize` | `(input, call) => { entries, targets }` — compiles or renders the reviewable form and its anchors  |
| `blockType`   | The node family that renders the artifact's body, registered in the client with `registerRenderer` |

**The rule that decides what a kind is**: the deliverable needs a **rendered, addressable surface** the conversation does not give, with revisions and anchors worth reviewing. Everything the conversation or another bundle already shows well **is not** an artifact kind:

| Candidate     | Verdict   | Why                                                                                                                                              |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preview`     | **Yes**   | It is the reason for being: a live interface, built from real code, with an anchor per element and revisions                                     |
| `plan`        | **No**    | The plan already is the agent's text in the conversation; an artifact would be the same thing rendered twice                                     |
| `walkthrough` | **No**    | It is the final summary, and it already is the Thread's last message                                                                             |
| `diff`        | **No**    | The diff has a home: the `git` changes panel, with the editor and the colors the platform already provides                                       |
| `diagram`     | **No**    | Markdown with a diagram already renders in the conversation; only an interactive diagram would need a surface of its own                         |
| `recording`   | **Maybe** | A recording is media the conversation does not show — but its natural owner is the bundle that produces the capture (`screen`), not the registry |

What the table buys: the registry **is not a taxonomy copied from Antigravity**. It exists for what the conversation cannot show, and the list shrank from six kinds to one — `preview` — plus the door left open for whoever has a real surface. A `screen` that records an app's run can register `recording` in the same contract, with its own `blockType` and its own `materialize`.

## The node

- **One block per revision**, with a stable identity: replay rebuilds every block and no revision disappears.
- **The `blockType` belongs to the kind**, registered in the client with `registerRenderer({ blockType, elementTag })` ([events and nodes](./events-and-nodes.md)); the element carries the prefix of the owning bundle, as [UI composed by bundles](./ui-composition.md) requires.
- **The frame belongs to the registry, the body to the kind.** Title, kind, the revision reading and the comment action with its count belong to the `artifacts` bundle — the same on every artifact; the kind renders the body (the preview's canvas, a recording's media). The frame has chrome variants, as papercraft draws them: the node's in the conversation and the full-screen window's. The authorize action appears only under the `request` policy. A kind whose body overlays its own header declares `header: 'body'` (the default is `'frame'`): the frame then does not draw the bar — title, kind, revision, state and `Comentar` belong to the body — and keeps below the body only what belongs to the registry, `Autorizar` (under `request`, on an open revision). The frame draws no list of revisions: each revision is a node of the conversation, and the conversation — with the agent's replies — is the history. Papercraft's `preview` declares `header: 'body'`.
- **A single reducer.** The `artifacts` bundle reduces `artifacts.*` to one state per artifact — current revision, pending comments —, and the same reducer serves the node and the window.

## Review: comments

The comment is the user's contribution to the artifact, and has its own spec in [comments](./comments.md): a **target** (the revision), an **anchor** (the stamped element, a selector, a position), two records (the durable event and the prompt the agent reads), a draft in the host and a flush on send.

The artifact defines none of this — it is just a target like any other. That is what makes the same mechanism serve to comment on a message, a line of code or a preview revision.

## The review policy

Doric is **YOLO by default**: the agent publishes the artifact and **goes straight on**. The user looks, comments and the agent adjusts in the next revision — the comment corrects the course, and does not open a queue of approvals.

Prior review exists as **the Project's choice**, declared with `defineSettings` and served by `settings/v1`:

| Policy              | What happens                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `proceed` (default) | The artifact is published and the agent continues; no approval event is written                                       |
| `request`           | The agent publishes, returns the state and **waits** for `artifacts.approved/v1` before writing to the Project's code |

The policy belongs to the Project because a production repository may want the gate a prototype does not — but the gate is the exception, not the rule, and the design does not depend on it: without `request`, the authorize button does not exist, the approval event does not exist, and the conversation remains the place for adjustment. What `proceed` means exactly is left open (decision 4).

## The agent's tool

**The kind owns its tool.** The `preview` already has `papercraft_preview` ([papercraft](./papercraft/README.md#tool-do-agente)), and a future kind brings its own: the input's shape, the validation and the materializing belong to the kind, and a generic artifact tool would be a union schema or a passthrough — worse in both cases. The `artifacts` bundle owns the registry, not the production of each kind; it is the same division as "the owner of an operation defines its hooks".

The tool **does not block** under the default policy: it publishes the artifact, returns the resolved state and the agent goes on. What teaches **when** to propose an artifact is the kind's skill, not the tool's body — the division [papercraft](./papercraft/README.md#skill-do-agente) already makes.

## Antigravity as a reference

| In Antigravity                                                | In Doric                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Artifact: a structured deliverable that communicates progress | Project artifact, with identity, revisions and anchors                                        |
| Implementation plan, walkthrough, diff, diagram, recording    | **Only what needs a surface of its own** — `preview` —, and the door open for whoever has one |
| Review panel in the app and artifact selector in the CLI      | Conversation nodes and `notifications` for the notice                                         |
| Viewer with per-line comments and a comment indicator         | Anchored comment, with a source stamp and a pin ([comments](./comments.md))                   |
| Review policy: request review or go straight on               | `artifacts.reviewPolicy` in `settings/v1`, with **`proceed` as the default**                  |
| Approve and reject per file, and in bulk                      | Only under `request`: `artifacts.approved/v1` with `scope`                                    |
| Artifacts in the conversation folder and in the app data      | `/workspace/.doric/` in the Project, with the durable log as the truth                        |
| Automatic detection of the files written                      | Declaration by the kind, in the kind's tool                                                   |

What is **not** copied: the taxonomy of kinds (plan, walkthrough, diff, diagram), because in Doric these things already have a home — the conversation and `git` —; the implicit detection, because an artifact declares its kind and its anchors; storage outside the Project; and the approval gate as the normal path, because Doric goes straight on.

## How it enters the composition

| Part          | What it contributes                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`        | `artifacts/v1`, the `artifact.kind/v1` kind registry, the `artifacts.*` events and the settings; `requires` `tools/v1`, `events/v1`, `skills/v1`, `settings/v1`, `storage/v1`, `runtime.lease/v1` |
| `desktopMain` | The verified cache of the compiled entries in `userData/artifacts/<artifactId>@<revision>/` and the `/artifacts/` prefix in the protocol handler                                                  |
| `client`      | The node's frame, the `artifacts.*` reducer and the comment action                                                                                                                                |

The bundle goes into `enabled` in the composition (`app/backend/doric-host/composition.json`), as [papercraft](./papercraft/README.md) describes for itself. No new contract is `doric.*`: `artifacts/v1` and `artifact.kind/v1` are bundle contracts and can be replaced like any contract without the prefix ([services between bundles](./services-and-channels.md)).

## Delivery stages

1. **Registry and events.** `artifacts/v1`, the manifest, `artifact.kind/v1`, the reducer and the node's frame; papercraft's `preview` becomes the `preview` kind.
2. **Cache and route.** The hash-verified cache in `desktopMain` and the route `/artifacts/<artifactId>@<revision>/…`, with the path guard `/bundles/` already has.
3. **Comments.** The [comments](./comments.md) registry on the `artifact` target, with the flush and the composer stack.
4. **Policy.** `artifacts.reviewPolicy` in `settings/v1`, with `proceed` as the default and the full `request` path.
5. **New kinds.** When a bundle has a real surface — a `screen` recording, an interactive diagram —, it comes in through the same `artifact.kind/v1`.

## Open decisions

1. **Decided: the directory is `/workspace/.doric/artifacts/<artifactId>/`** — at the root of the Project's workspace, which the Threads share, reached through the lease, ignored by Git by default. It closes decision 4 of [papercraft](./papercraft/README.md#decisões-em-aberto).
2. **Decided: the events are `artifacts.*`, with `kind` in the payload**, and the comment is **not** one of them: it belongs to the [comments](./comments.md) registry, with the artifact as its target.
3. **Decided: `proceed` is the default** (YOLO) and `request` is the Project's choice. What remains is what `proceed` means in detail.
4. **What `proceed` means.** Whether the agent publishes the artifact and goes on without writing any approval, whether a comment arriving later produces an automatic revision, and whether `applied` is emitted at the end of the turn or when the agent decides.
5. **Who emits `artifacts.applied/v1`.** The kind's tool after the write, or the write-back step, when it exists as a service.
6. **The shape of `artifactId`.** An opaque UUID, a readable id derived from the title, or a per-kind prefix (`preview-…`). It changes the look of the directory and of the URL paths.
7. **Retention.** When the working copy in `.doric/` and the cache can be deleted — by age, by limit, when the Thread ends — and what the screen shows afterwards.
8. **Orphan artifact.** What happens on replay when the kind's bundle is not active: the log already knows how to show an event without a projector in a generic block ([events and nodes](./events-and-nodes.md)), and what the frame shows in that state remains to be decided.
9. **`request` in detail.** Whether the policy can be per kind or per path, and what happens to an authorized revision that is superseded.
10. **Manifest versioning.** Whether `artifact.json` gains a `manifestVersion`, like the bundle manifest, and what to do with a directory from an earlier version.
11. **Artifact outside a Thread.** Today the scope requires `projectId`, `threadId` and `promptId`; an artifact of the whole Project would need another scope.
12. **`.doric/` as Doric's directory.** `artifacts/` is the first domain; what else lives in it (an index, a Project state) and whether it gets a `.gitignore` of its own remain to be decided.

## References

- [Artifacts](https://antigravity.google/docs/artifacts) (Antigravity): the definition of an artifact and asynchronous collaboration.
- [Implementation plan](https://antigravity.google/docs/implementation-plan) (Antigravity): the plan as an artifact — the kind Doric deliberately does not copy, because the plan already is the conversation.
- [Artifact review](https://antigravity.google/docs/artifact-review) (Antigravity): the review policy, `Request review` and `Always proceed` — Doric inverts the default.
- [Reviewing artifacts](https://antigravity.google/docs/cli/artifacts) (Antigravity CLI): the artifact selector, the viewer and the per-line comment.
- [Antigravity default files & directories](https://github.com/atdanri/ai-knowledge/blob/develop/docs/ai/tools/antigravity/files.md) (third-party documentation): Antigravity's on-disk structure — the conversation folder with `implementation_plan.md`, `task.md` and `walkthrough.md` —, useful as a contrast with `/workspace/.doric/`.
- [Events and nodes](./events-and-nodes.md): the durable log, the sinks with `scopeKeys`, the projection into blocks and `registerRenderer`.
- [Contracts and the define\* family](./contracts.md): `defineEvent`, `defineService`, `defineSettings` and the generation of the canonical JSON Schema.
- [Generic storage and history](./storage.md): where the log is persisted and how the local cache is addressed per bundle.
- [Composition and distribution by the host](./composition-and-distribution.md): the catalog, the verified cache and the sense of "artifact" on the platform.
- [Services between bundles and message channels](./services-and-channels.md): cardinality `one` and `many`, `desktopScope`, `expose: 'desktop'`.
- [Contexts and capabilities](./contexts.md): the `call` with `scope` and the `caller` of each hop.
- [Papercraft](./papercraft/README.md): the `preview` kind, the canvas in the node and in the window.
- [Comments](./comments.md): the concept spec the artifact uses as review state.
