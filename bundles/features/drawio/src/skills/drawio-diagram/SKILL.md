---
name: drawio-diagram
description: 'Publishes a draw.io diagram as a node of the conversation, where the user comments on shapes and connectors and can edit it. Use when the user asks for a diagram, or for an architecture, a flow, a sequence or a data model.'
allowed-tools:
  - drawio_diagram
  - comment_reply
  - write
  - edit
  - terminal
order: 3410
---

# draw.io Diagram

## Purpose

Show a structure as a **diagram** the user can see, comment on and edit, instead of describing it in prose. The `drawio_diagram` tool publishes a draw.io file as a node of the conversation. It is an **artifact** — the `diagram` kind of the Project's artifact registry —, so it has a stable `artifact_id`, immutable revisions, and comments anchored to its shapes and connectors.

## Use this skill when

- the user asks for a diagram;
- the answer is an architecture, a flow, a sequence or a data model;
- a diagram already exists and the user asks for an adjustment: publish a **new revision** of it (`artifact_id`), never a new diagram.

## Writing the file

- Write an **uncompressed** `mxfile`: one `<diagram>` per page, each with an `id` and a `name`, holding its `<mxGraphModel>` as XML.
- Give every cell its geometry (`<mxGeometry>`), and every connector a `source` and a `target`.
- Write labels as plain text.
- Keep cell `id`s stable across revisions. Never reuse an `id` for another element; a new element gets a new `id`. Comments anchor to these ids.

## Procedure

1. **Create**: write the draft to `.doric/artifacts/drafts/<name>.drawio` and call `drawio_diagram` with `title` and `path`. It returns the `artifactId`, the revision, the pages and the unresolved comments.
2. **Revise**: edit the same draft, then call `drawio_diagram` with `artifact_id`, `base_revision` — the revision the last output gave — and `path`.
3. **Newer revision**: when the call is refused because a newer revision exists (the user's own edit, for example), call `drawio_diagram` with `artifact_id`, `checkout: true` and a **new** `path`. Read that file with `terminal` (`cat`), reapply there the changes that still apply, and publish from it with `base_revision` set to the revision you checked out.

## Comments

- A comment's anchor `page/<p>/cell/<id>` is a cell; `page/<p>/point/<x>,<y>` is a free point of the page, and its `element` is the nearest cell.
- Answer each comment with `comment_reply`, and resolve it after publishing the revision that does what it asks.

## Approval

Diagrams have no approval: publish and carry on.

## Completion

The user has the diagram in the conversation at its latest revision, and every comment has been answered.
