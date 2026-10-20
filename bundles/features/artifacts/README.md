# Artifacts bundle

`artifacts` gives the things an agent makes to show its work a durable home.
Every deliverable gets a stable id, revisions that are never overwritten, a
frame in the conversation you can comment on, and, when a Project asks for it,
an approval step before the agent touches the Project's code.

It is a feature bundle with a host part (the registry, the kind registry, the
events and the review setting), a desktop part (the verified byte cache) and a
client part (the frame in chat and the Review settings section), loaded by the
`bundle` platform. It owns no artifact kind itself: a bundle such as
[`papercraft`](../papercraft/README.md), whose live previews are the first
kind, registers one and draws its body. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## Why it matters

- **Revisions you can compare.** Revision 2 never replaces revision 1. Every
  revision keeps its own files, anchors and comments, and the conversation
  shows one frame per revision next to what the agent said about it.
- **Rebuilt from the log.** Every transition is one durable event in the
  Thread log, so replay and rewind rebuild each artifact revision by revision.
- **Your source tree stays clean.** Artifact files live in the Git-ignored
  `.doric/artifacts/` area of the Project, never in your code.
- **You choose how much control to keep.** By default the agent publishes and
  moves on, and your comments steer the next revision. A Project can instead
  ask for review, and each new revision then waits for you to press
  **Autorizar**.
- **One registry for every kind.** A new kind of deliverable registers itself
  and gets identity, revisions, events, comments and the review frame without
  reimplementing them.

## What it provides

- **Contracts:**
  - `artifacts/v1` (host): `create`, `revise`, `read`, `list`, `revisions`,
    `approve`, `awaitApproval` (host only), `policy`, `setPolicy` and `apply`;
  - `artifact.kind/v1` (host): `register` and `list` for artifact kinds;
  - `artifacts.cache/v1` (desktop): `ensure`, the verified cache of a
    revision's files.
- **Events:** `artifacts.created/v1`, `artifacts.revised/v1`,
  `artifacts.approved/v1` and `artifacts.applied/v1`.
- **Setting:** `artifacts.review-policy/v1`, the review policy of each Project.
- **UI:** `<artifacts-node>`, the frame drawn for every revision in chat, and
  `<artifacts-settings-review>`, the **Settings → Review** section at
  `/settings/review`.

The bundle provides no tool and no skill; the bundle that owns a kind provides
the tool the agent calls (for previews, `papercraft_preview`).

## Artifacts and revisions

An artifact has an id, a `kind`, a title, and one or more immutable revisions.
Each revision records:

- **targets:** the code anchors it touches (`path` plus `line`, `lines` or
  `snippet`);
- **entries:** its files as `{ path, sha256 }`, never the bytes;
- optional `source` (`html`, `component` or `site`), `path`, `entry`, `notes`
  and, for a `revise`, a `changeNote`;
- its review state, `open` or `approved`.

Without a caller-chosen id, the id is a slug of the title (up to 48
characters) plus a four-character hex suffix, such as `checkout-7f3a`.

A caller either hands over ready `entries` with their bytes in `files`, or
sends a `payload` that the kind's own schema validates and its `materialize`
turns into entries. Either way, every file's bytes are checked against its
entry's SHA-256 before they are written.

### Storage

The work copy lives in the Project's sandbox, reached through
`runtime.lease/v1.withLease`; the registry never acquires a lease of its own.

```text
/workspace/.doric/.gitignore                       *
/workspace/.doric/artifacts/<artifactId>/artifact.json
/workspace/.doric/artifacts/<artifactId>/<revision>/<path>
```

- The Thread log is the durable truth; `artifact.json` can be regenerated.
- Reads fall back to the older `<artifactId>/<path>` layout and serve only
  bytes whose hash still matches.
- Without a lease, reads answer empty and mutations refuse with `unavailable`.
- Artifact ids, entry paths and cache paths are checked against path traversal
  in the contract, the store and the desktop cache.

### Transitions

A mutation needs the full call scope (`projectId`, `threadId`, `promptId`) and
runs one at a time per Project and artifact. Everything that can be refused is
checked first; then the registry writes the files, the manifest and the event,
and undoes the transition when a later step fails. A revision lands in the log
of the Thread that made it, so `artifacts.revised/v1` also carries the
artifact's `kind` and `title`.

## Artifact kinds

A bundle declares a kind through `artifact.kind/v1.register` during
activation:

| Field         | Meaning                                                           |
| ------------- | ----------------------------------------------------------------- |
| `id`          | Kind id, lowercase segments joined by `.` or `-` (`preview`)      |
| `title`       | Display name                                                      |
| `payload`     | Zod schema the registry validates a `payload` with                |
| `materialize` | The kind's own derivation of entries, anchors and bytes           |
| `blockType`   | Block type handed to the body element                             |
| `bodyTag`     | Custom element the frame mounts as the body of one revision       |
| `header`      | `frame` (default) or `body`, for a body that draws its own header |

`register` returns a `Disposable` tracked on the caller's generation. The same
bundle registering an id again replaces its declaration; another bundle
claiming an id in use gets `registration_conflict`. An artifact whose kind no
active bundle registered is still stored and still drawn.

## The frame

The client projects all four events with one reducer and draws one
`artifacts.frame/v1` block per revision. The frame is the registry's and the
body is the kind's:

- the bar shows the title, the kind, `rev N`, the review state and
  **Comentar**, with the count of unresolved comments on that revision;
- the body is the kind's `bodyTag` element; a kind without a body shows the
  revision's entries instead;
- under `request`, an open revision shows **Autorizar**, which calls
  `artifacts/v1.approve`;
- with `header: 'body'`, the frame draws no bar and keeps only **Autorizar**
  below the body.

**Comentar** dispatches the bubbling `artifacts:comment` DOM event with
`{ artifactId, revision, kind }`; if no surface handles it, the frame hands the
gesture to the body. Comments themselves belong to the
[`comments`](../comments/README.md) bundle, with target kind `artifact`, the
artifact id and the revision. The frame draws no revision list: the
conversation is the history.

## Review policy

**Settings → Review** offers two choices per Project, stored in
`artifacts.review-policy/v1`:

| Choice          | Policy    | Behavior                                                         |
| --------------- | --------- | ---------------------------------------------------------------- |
| `Seguir direto` | `proceed` | Default. Publish and continue; comments steer the next revision. |
| `Pedir revisão` | `request` | Publish, report the approval as pending and wait for Autorizar.  |

- Approval belongs to one revision: a new revision starts `open` again.
- The kind's tool reports the policy to the agent; `papercraft_preview`
  answers at once with the approval pending and tells the agent not to
  implement the change until it is approved.
- Under `proceed`, `approve` records nothing.
- `awaitApproval` resolves at once under `proceed` or for an approved revision,
  otherwise when `approve` records it or `timeoutMs` passes.
- `apply` records `artifacts.applied/v1` and, under `request`, refuses a
  revision nobody approved. No kind calls `awaitApproval` or `apply` yet.

The settings window reads and writes the policy through `artifacts/v1`
(`policy`, `setPolicy`), because `settings/v1` is not exposed to the desktop. A
`setPolicy` call scoped to no Project sets the default for every Project
without a choice of its own.

## Desktop cache

`artifacts.cache/v1.ensure` takes a revision's entries as `artifacts/v1.read`
returns them (`{ path, sha256, base64 }`) and writes each file under the
bundle's cache directory only once its SHA-256 matches. Writes are staged and
renamed into place, so a partial file is never served. The
`doric://app/artifacts/<artifactId>@<revision>/…` route then serves what
passed.

## Design

The design, in Portuguese and including parts not built yet, is in
[`docs/architecture/bundles/artifacts.md`](../../../docs/architecture/bundles/artifacts.md).
`GROUNDING.md` remains the contract for what is implemented.

## Development

```console
npx nx build bundle-artifacts
npx nx typecheck bundle-artifacts
npx nx test bundle-artifacts
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
