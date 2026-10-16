---
name: papercraft-preview
description: 'Publishes a visual change as a live preview node of the conversation, built from real code, instead of describing it. Use when the change is easier to judge by looking than by reading a diff, and the user should see it, comment on it and steer it.'
allowed-tools:
  - papercraft_preview
  - write
  - edit
order: 3400
---

# Papercraft Preview

## Purpose

Let the user **see** the change instead of imagining it. The tool publishes real code — an HTML file of the Project, or a Project component's source — as a live preview in a node of the conversation, where the user selects, comments and asks for adjustments. The preview is a **window, not a gate**: the Doric default is to proceed, so publish the preview and implement the change, and let the comments steer. It is an **artifact** — the `preview` kind of the Project's artifact registry —, so it has a stable `artifact_id`, immutable revisions, and the anchored comments as its review state.

## Use this skill when

- the change is visual and easier to judge by looking than by reading a diff: layout, spacing, a component's states, a new screen;
- the user asks to see, preview, mock or prototype a UI, or to compare alternatives;
- the user has not decided yet — a preview is cheaper to change than an implementation;
- an earlier preview exists and the user asked for an adjustment: publish a **new revision** of the same preview, so the previous node and its comments stay.

## Do not use this skill when

- the change is not visual: refactors, data, configuration, scripts, docs;
- the goal is to inspect the running app rather than a proposed state;
- the preview would need a running server or third-party content the app cannot host: say what is missing instead of previewing something else.

## Procedure

1. Decide the preview's source from the code the change touches — read the Project's component index first when there is one: `component` when it is an existing Project component, so the preview is stamped with the real file and a comment becomes an edit instruction; `html` for a new idea with no component yet.
2. Write the payload where the change would live and pass its **Project-relative path** — the source of the preview is a file of the Project, read through the sandbox like any other (the host refuses a path outside the workspace root, as the sandbox does).
3. Call `papercraft_preview` with the title, the source (`html` or `component`), the path and, optionally, the anchors (`targets`) and a note. It builds the payload, creates the artifact at revision 1 and returns the resolved preview state — the revision and the built markup — not a write confirmation.
4. Implement the change with the normal tools, in the code the preview shows. The preview is not a gate — wait for `artifacts.approved/v1` only when the Project's review policy asks for a review.
5. On comments, publish a **new revision** of the same preview through the artifact registry, so the previous node and its comments stay and the reader can compare "what I asked" with "what came". Comments arrive as durable events with an anchor — the stamped file, a selector, or a position — so address them.

## Completion

The user has a live preview of the change, with its revision shown and the comments anchored to it, and the change was implemented in the code the preview shows — or is waiting for the review the Project asked for.
