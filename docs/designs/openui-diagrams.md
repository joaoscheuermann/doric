# Spec: diagrams in OpenUI fences, phase 1 — `Flowchart`

- Ticket: none. The work comes from the accepted concept [docs/features/openui-diagrams.md](../features/openui-diagrams.md); no Linear issue exists for it.
- Status: `accepted`, version 5 (2026-11-06), approved by the user after the Readiness and Codebase reviews ([Revisions](#revisions)). Code implemented 2026-11-06 (`openui` 2.2.0); acceptance is pending: phase 1 ships only after the [Acceptance](#acceptance) checks and the user's acceptance ([Phases](#phases)). The `packages/bundle` license-files follow-up is still open. [Phase 2](openui-diagrams-phase2.md) replaced some of this spec's decisions in the code: F10's four skill rules became F22's five rules for all four types; `FlowchartView`'s state machine became the shared `useDrawn` hook; `DiagramCanvas` became a wrapper over `DiagramFrame`; and the outline became generic for every type. [openui-diagrams-square-area.md](openui-diagrams-square-area.md) replaces F7's area height and removes the `height` prop.
- Scope: phase 1 of [UD13](../features/openui-diagrams.md#decisions): `Flowchart` with `Node`, `Edge` and `Group`, the layout chunk (ELK), the pan and zoom helpers shared through `packages/desktop`, drawing, the checks and the skill. Phase 2 (`SequenceDiagram`, `EntityDiagram`, `MindMap`) is outside this document and specified in [openui-diagrams-phase2.md](openui-diagrams-phase2.md); phase 1 builds for `Flowchart` only, and phase 2's spec decides how its types join the reading, the check, the outline and the layout.
- Companions: [openui.md](openui.md) (fences, revisions, the progressive merge D5, the library D7, the skill D17, validation feedback D18) and [conversation-openui.md](conversation-openui.md) ([D29](conversation-openui.md#d29-the-conversation-renderer-in-the-app), the renderer that draws an `openui-lang` fence in the conversation, with its error card and its program check; [D20](conversation-openui.md#d20-actions-back-to-the-agent-p1), the actions a fence sends back to the agent).
- Identifiers: G goals, UD the user's decisions and P the proposals of the concept, A the concept's [riskiest assumptions](../features/openui-diagrams.md#riskiest-assumptions), D and U the decisions of the companion specs, F this spec's design decisions, FT its tests, FR its risks, M its measurements.
- Bundles and packages touched: `openui` (2.1.0 → 2.2.0), `papercraft` (imports the moved helpers; its version does not change, F12), `packages/desktop` (the new subpath `desktop/ui/viewport`).
- Feature docs: [docs/features/openui-diagrams.md](../features/openui-diagrams.md) (the concept, status `implemented` for both phases) and [docs/features/generative-ui.md](../features/generative-ui.md) (the conversation's generative UI, status `implemented`).
- Paths are written from the repository root. Line references are checked against commit `fc76b9fa` and name each file as it is before this change. `openui` paths are under `bundles/features/openui/` unless written in full. References to OpenUI packages name the installed files of the pinned versions (lang-core 1.0.2 at `node_modules/@openuidev/lang-core`, react-lang 1.0.2 at `bundles/features/openui/node_modules/@openuidev/react-lang`).
- Measurements were made on 2026-11-06 in a throwaway folder outside the repository, against elkjs 0.11.1 and 0.12.1 and the repository's installed OpenUI packages, zod and esbuild. The scripts are not kept: [Measurements](#measurements) describes each so that it can be repeated, and the random-graph generator they used enters the repository as a test helper (Test plan), so FT4–FT6 repeat M4's checks.

## Contents

- [Problem](#problem)
- [Terms](#terms)
- [Goals](#goals)
- [Decisions already made](#decisions-already-made)
- [Non-goals](#non-goals)
- [Design decisions](#design-decisions)
- [Design](#design)
- [Phases](#phases)
- [Files to change](#files-to-change)
- [Test plan](#test-plan)
- [Measurements](#measurements)
- [Alternatives considered](#alternatives-considered)
- [Risks](#risks)
- [Open questions](#open-questions)
- [Docs to update](#docs-to-update)
- [Revisions](#revisions)

## Problem

The conversation library has no diagram component (`src/client/library.ts:59-61` adds only the three question built-ins and an inline `Modal` to react-ui's 82 components), and no renderer draws a `mermaid` fence ([concept, Problem](../features/openui-diagrams.md#problem)). The user accepted the concept and its proposals P1–P14 and chose to ship `Flowchart` first (UD13). The concept leaves to this spec: the schemas and defaults of the four phase 1 components, the limits as enforced, the form of lists (P4), the layout chunk's interface and options, the drawing, the shared viewport code, the checks' exact findings, the skill's rules, and how Doric meets elkjs's EPL-2.0 obligations (UD7).

## Terms

The terms of the concept ([Terms](../features/openui-diagrams.md#terms)) apply: diagram component, part, id, outline, diagram model, entry, renderer chunk, ELK, layered, hierarchy handling, orthogonal routing, random seed. This document adds:

- **box**: The drawn shape of one node. A group is not a box.
- **character**: One Unicode code point, as JavaScript's `[...text].length` counts. Every limit and every text the agent reads counts in characters.
- **drawn part**: A part the diagram model keeps after reading: valid, within the limits, with existing references. Only drawn parts reach the layout and the picture.
- **error card**: The card under a fence that lists its program's errors once the fence is not streaming ([The reader's error card](conversation-openui.md#the-readers-error-card)); the same lines are reported to the agent through `openui.programs/v1` ([D18](openui.md#d18-validation-feedback-u19)).
- **finding**: One problem the reading found in a diagram's program, written as one sentence that ends with a period; the check numbers a statement's findings and joins them into one reported error (F3).
- **fixture `n/e/g/d`**: A graph of the random-graph generator (Test plan) with `n` nodes, `e` edges, `g` groups and groups nested at most `d` levels deep; `n/e/none` has no groups. Each fixture exists for the seeds 7919 × s, s = 1…5; "seeds 1–5" below means these five.
- **fit**: The viewport that shows the whole drawing centered in its area with a margin, never above 100 % and never below 25 % (`fitViewport`, `bundles/features/papercraft/src/client/surface/viewport.ts:64-86`).
- **interactive**: A drawn diagram the reader can pan and zoom. It is interactive exactly when its fence's actions work ([When an action works](conversation-openui.md#when-an-action-works)): its Thread is a main Thread and not an agent's, its fence is `closed` (neither `streaming` nor `unterminated`), and its revision is the latest of its key (`blockedReason`, `src/client/chunks/renderer.ts:219-234`). Otherwise it is static and fitted (UD8). A fence is not remounted while it streams (`fence-node.tsx:1-6`), so within one mount a diagram turns interactive when its fence closes as the latest revision of a main Thread, and turns static only when a newer revision arrives. While a click of the same fence is sending, the renderer's wrapper is `inert` (`inert: blocked !== undefined || sending`, `renderer.ts:322`, for at least `BUSY_MS`, 500 ms, `:213`): input does not reach the diagram, but it stays interactive, keeps its viewport and its toolbar (F8).
- **latest revision**: A fence's revision when no later fence of the Thread has a revision of the same identity (`latest`, `src/client/chunks/renderer.ts:49-50`); older revisions keep their pictures, but their actions are off (U26, [conversation-openui.md](conversation-openui.md#decisions-already-made)).
- **layout chunk**: `client/chunks/layout.js`, built from `src/client/chunks/layout.ts`: elkjs and the one function that calls it (F6).
- **layout graph**: The input of the layout chunk: the drawn parts as keyed boxes with sizes, their nesting and their connections; no labels, ids or colors (F6).
- **layout result**: The output of the layout chunk: positions of boxes and groups, edge routes and edge label boxes, in one coordinate system (F6).
- **layout loader**: The renderer chunk's single path to the layout chunk, one per window: it imports the chunk at its first call (F6).

## Goals

The concept's goals ([Goals and success measures](../features/openui-diagrams.md#goals-and-success-measures)) as they apply to phase 1, with what decides each. As in the concept, the targets state what the design aims at and gate nothing. In phase 1 the prompt set is the 8 flowchart and architecture prompts of [Acceptance](#acceptance), 3 runs each: 24 fences, plus 6 patch revisions.

| Goal                                         | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 The agent writes a `Flowchart` when asked | Share of the 24 fences that hold a `Flowchart`, and for the 4 architecture prompts at least one `Group`; target ≥ 90 % ([Acceptance](#acceptance))                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| G2 Valid when first written                  | Share of the 24 fences whose closed revision has no line in the error card; target ≥ 90 %. The 6 patch revisions are counted apart, with the same target ([Acceptance](#acceptance))                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| G3 (a) Readable, automatic                   | FT4 on every fixture up to the limits, both directions: zero box overlaps, edges through a box, boxes in a foreign group, overlapping sibling groups, edge labels on a box; FT16 for contrast                                                                                                                                                                                                                                                                                                                                                                                                                               |
| G3 (b) Readable, judged                      | The user judges the 24 drawn diagrams; target ≥ 80 % ([Acceptance](#acceptance))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| G4 Immediate feedback                        | Outline: ≤ 500 ms from a part's line reaching the Thread log to the part in the outline, the concept's target. This spec adds no step to that path: the outline is computed in the same render that receives the revision, which FT13 asserts. Drawn: ≤ 500 ms from the fence's close to the drawn diagram for the fixture 50/70/10/3 once the layout chunk is loaded, ≤ 1 s for a window's first diagram, checked by A2                                                                                                                                                                                                    |
| G5 No cost to fences without diagrams        | FT8: the renderer chunk holds no ELK code; the layout chunk is imported only at the layout loader's first call (FT10), which only a `Flowchart` that is not streaming makes. Growth of `dist/client/chunks/renderer.js` from `npx nx build bundle-openui` before step 1 and after step 4, in raw bytes as the concept measures sizes: ≤ 100 KB (the concept's target), checked at [Acceptance](#acceptance). The layout chunk itself, 2,609,437 bytes raw and 502,932 bytes after `gzip -9` (M6), ships in every packaged build and is read from disk only when a diagram is laid out; its size is the accepted cost of UD7 |
| G6 The skill stays small                     | FT14: the generated skill grows by at most 4,000 characters; measured with F10's rules: 1,632                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Decisions already made

From the concept, binding here:

- **UD1, UD2** Flowchart and architecture as native components with automatic layout and the app's theme.
- **UD3** `openui-lang` fences only.
- **UD4** Pan and zoom; no click actions on parts.
- **UD5** No export.
- **UD6** No Mermaid.
- **UD7** ELK is the layout engine; its license is accepted; dagre and d3-hierarchy do not ship. Checked by FT8: the built layout chunk carries the license statement and notices of F11.
- **UD8** A fence whose wrapper is `inert` shows a static, fitted diagram; the renderer's `inert` does not change. Checked by FT15: a diagram that is not interactive has no zoom controls and no focusable area, and its viewport is the fit.
- **UD11** No icons in nodes. (UD9 and UD10 concern phase 2.)
- **UD12** P6's limits: 100 nodes, 200 edges, 25 groups and 4 levels of group nesting per `Flowchart`; labels cut at 120 characters.
- **UD13** Phase 1 is this document.
- **P1–P14** as written in the concept, with what this spec settles: P4 (lists) in F10, P5 (placement) in F1, P6 (limits) in F2, P7 (skill) in F10, P8 (ELK `layered`) and P10 (layout once per revision, in a chunk, on the main thread) in F6, P9 (outline) in F4, P11 (SVG and theme) in F7, P12 (errors) in F2 and F3, P13 (gestures, shared helpers) in F8 and F9, P14 (`inert` kept) in F8.

The user's answers to the questions of versions 1 and 3 (2026-11-06):

- **Distribution.** Doric is not a commercial product offering that distributes ELK, so EPL-2.0 §4 does not apply. No legal review is needed. The layout chunk carries ELK's notices and the source statement (F11).
- **License texts** (after version 3). The full texts of third-party licenses ship for every bundle through a separate change in `packages/bundle`, in the style of `copyLicenses` (`app/desktop/doric-platform/build.mjs:379-422`), outside this spec; that change must also cover the Apache License 2.0 of the GWT and Guava code inside `elk.bundled.js` (F11). It is a follow-up, not a release precondition: phase 1 may ship before it (decided after version 4), and FR12 is the accepted risk until it lands.
- **Acceptance prompts.** The 8 prompts of [Acceptance](#acceptance), 3 runs each, are accepted, and (after version 3) the 2 patch prompts.
- **No spike.** Implementation starts without a spike; the validation of A1, A2 and A6 stays in [Acceptance](#acceptance).

## Non-goals

- Phase 2 components and any abstraction for them: the reading, the check, the outline and the layout interface serve `Flowchart` only.
- Diagram components in papercraft fences (UD3). Papercraft's library is unchanged; a `Flowchart` in a `papercraft` fence gets OpenUI's own `unknown-component` error. Papercraft gives the conversation-only `AskForm` a dedicated message (`bundles/features/papercraft/src/client/program-errors.ts:105-146`); it gives the diagram components none.
- Clicks on parts, links, tooltips, selection, dragging parts (UD4).
- Export of any kind (UD5).
- Slots: the five closed-union containers (`Card`, `TabItem`, `AccordionItem`, `Carousel`, `Modal`) do not list `Flowchart` in the prompt (P5). A `Flowchart` the agent writes inside one anyway parses without error (M5) and is drawn; nothing reports or blocks it.
- Colors, positions or sizes written by the agent; edges to or from groups; ports.
- Durable view state: the viewport resets when the fence remounts.
- Keys that pan or zoom. From the keyboard, the toolbar's buttons zoom and fit; there are no pan keys.

## Design decisions

| #   | Decision                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `Node`, `Edge`, `Group` and `Flowchart` are defined from data in a React-free client module; `edges` is optional so that a diagram stays in the render while its lists stream. The contracts module does not change.                                             |
| F2  | One pure reading turns a `Flowchart`'s props into its diagram model: the drawn parts in program order and the findings, in a fixed order with fixed texts.                                                                                                       |
| F3  | The conversation's program check reports a statement's diagram findings as one numbered `runtime-error` line that fits the reporter's 300 characters, merged with an existing one of the same statement; layout and load failures are not reported to the agent. |
| F4  | While its fence streams a `Flowchart` shows its outline; once `closed` or `unterminated` it is laid out once per mount and drawn. The fence context gives the state, the interactivity and the layout.                                                           |
| F5  | Labels are measured in the drawing's font once the faces their characters need have loaded, wrapped to a width per shape, and boxes are sized so the padded label fits inside the shape.                                                                         |
| F6  | The layout chunk runs ELK `layered` with hierarchy handling and orthogonal routing behind one `layout(graph)` function; the window's layout loader imports it at the first layout.                                                                               |
| F7  | The picture is SVG drawn by React; every color is a role over Doric's tokens with tested contrast; the area's height comes from `height` or the fitted drawing, within fixed bounds.                                                                             |
| F8  | An interactive diagram pans and zooms as papercraft's canvas node does in the conversation; a static one shows the fit and no controls.                                                                                                                          |
| F9  | The pure viewport helpers and the wheel rule move to `packages/desktop` as `desktop/ui/viewport`; papercraft re-exports them and its behavior does not change.                                                                                                   |
| F10 | Lists stay arrays of inline calls (P4, by token measurement); four Doric rules join the skill; the components are listed under "Other".                                                                                                                          |
| F11 | `openui` depends on `elkjs` 0.11.1, the version already in the lockfile; the layout chunk carries ELK's notices verbatim and the statement where its source is available; full license texts come from a separate `packages/bundle` change.                      |
| F12 | `openui` becomes 2.2.0; no contract changes; `papercraft`'s version does not change.                                                                                                                                                                             |

## Design

### Overview

```text
agent's fence ─▶ ConversationFence (renderer chunk)
                  ├─ FenceContext { view, revision, …, interactive, layout }   (F4, F8)
                  └─ Renderer ─▶ Flowchart component ─▶ readFlowchart(props)   (F2)
                                   ├─ streaming ─▶ outline                     (F4)
                                   └─ closed / unterminated
                                        ├─ label sizes                         (F5)
                                        ├─ layout loader ─▶ chunks/layout.js ─▶ ELK (F6)
                                        └─ SVG + viewport (desktop/ui/viewport) (F7, F8, F9)
programCheck ─▶ diagramCheck(parsed root) ─▶ readFlowchart ─▶ card and report  (F3)
```

### F1. The components

**Definitions.** A new module `src/client/diagram/definitions.ts` holds the schemas, the limits and the definer. It imports only `zod` and the type `DefineComponent` of `src/contracts/builtins.ts:15-23`, so the library (`src/client/library.ts`) and the skill test (`tests/client/skill-text.test.ts`) both import it, as both import the question built-ins today (`library.ts:15`, `skill-text.test.ts:22`). It is not exported from `src/contracts/index.ts`: the diagram schemas have no host contract and no second bundle reads them, and the contracts barrel is loaded in every window as `openui/contracts` and by papercraft (`tests/client-split.test.ts:5-7`, `bundles/features/papercraft/src/client/folds.ts:5`).

```ts
export const FLOWCHART_LIMITS = {
  nodes: 100,
  edges: 200,
  groups: 25,
  /** Levels of group nesting; a top-level group is level 1. */
  depth: 4,
  /** Characters (code points) of a label before it is cut. */
  label: 120,
  /** Characters (code points) of an id, at least 1. */
  id: 64,
} as const;

export const NODE_SHAPES = [
  'box',
  'round',
  'diamond',
  'circle',
  'cylinder',
] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

export const flowNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  shape: z.enum(NODE_SHAPES).optional(),
  group: z.string().optional(),
});
export const flowEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  line: z.enum(['solid', 'dashed']).optional(),
  arrow: z.enum(['end', 'none']).optional(),
});
export const flowGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  parent: z.string().optional(),
});

/**
 * Node, Edge, Group, then Flowchart with `nodes` of Node refs, `edges` of
 * Edge refs and `groups` of Group refs. Calls `define` exactly four times, in
 * that order; returns its results in that order.
 */
export const defineDiagramBuiltins: <
  C,
  D extends { readonly ref: z.core.$ZodType },
>(
  define: DefineComponent<C, D>,
  renderers: {
    readonly Node: C;
    readonly Edge: C;
    readonly Group: C;
    readonly Flowchart: C;
  },
) => readonly [D, D, D, D];
```

The definer takes `define` because `Flowchart`'s props refer to the parts' `ref`s, which only the caller's `defineComponent` makes: react-lang's in the library (`library.ts:8,21-24`), lang-core's in the skill test (`skill-text.test.ts:15,64`), as for the question built-ins. `Flowchart`'s props, in this argument order:

```ts
z.object({
  nodes: z.array(node.ref),
  edges: z.array(edge.ref).optional(),
  groups: z.array(group.ref).optional(),
  direction: z.enum(['down', 'right']).optional(),
  height: z.number().optional(),
});
```

The descriptions are the concept's ([Components](../features/openui-diagrams.md#components)). The prompt builder prints them as measured (M3):

```text
Flowchart(nodes: Node[], edges?: Edge[], groups?: Group[], direction?: "down" | "right", height?: number) — Boxes and arrows laid out automatically: flowcharts, pipelines, architecture with grouped regions.
Node(id: string, label: string, shape?: "box" | "round" | "diamond" | "circle" | "cylinder", group?: string) — One box of a Flowchart; group names the Group that holds it.
Edge(from: string, to: string, label?: string, line?: "solid" | "dashed", arrow?: "end" | "none") — A connection between two Node ids.
Group(id: string, label: string, parent?: string) — A region of a Flowchart; parent names the Group it sits in.
```

**Why `edges` is optional.** The concept's signature had `edges: Edge[]`. Measured (M1): while the fence streams and the `edges` statement is not yet written, lang-core drops an element whose required prop is an unresolved reference (`null-required`), so the whole `Flowchart` leaves the render until its last list starts; with `edges` optional the component receives `edges: null` and draws its outline. `nodes` stays required: the skill writes `nodes` right after the diagram statement (F10), and a program that never defines `nodes` gets lang-core's own `null-required` error at close. A `Flowchart` with nodes and no edges is drawn without a finding.

**Defaults.** `shape` `box`; `line` `solid`; `arrow` `end`; `direction` `down`; `height` per F7.

**In the library.** `library.ts` calls `defineDiagramBuiltins(defineComponent, { Node: none, Edge: none, Group: none, Flowchart: FlowchartView })`, where `none` is the library's existing renderer that draws nothing (`const none = () => null`, `library.ts:18`), beside the question built-ins (`library.ts:18-24`) and adds the four after them: `add: [AskForm, AskQuestion, AskOption, Flowchart, Node, Edge, Group]` (`library.ts:59-61`). The parts draw nothing: `Flowchart` reads them from its own props, the parts' elements as lang-core passes them (F2). This differs from `AskForm`, whose view takes no props and reads the fence's program through `useFence()` (`src/client/question/ask-form.tsx:125-131`). No name collides with react-ui's 82 components (M5).

**Placement (P5).** At the root (`root = Flowchart(…)`) or in a `Stack`; both parse with no error (M5). The library's root stays `Stack`.

### F2. Reading a Flowchart

`src/client/diagram/model.ts` exports one pure, total function used by the drawing and the check alike:

```ts
export interface FlowNode {
  readonly id: string;
  readonly label: string;
  readonly shape: NodeShape;
  /** The id of a drawn group, if any. */
  readonly group?: string;
}
export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly line: 'solid' | 'dashed';
  readonly arrow: 'end' | 'none';
}
export interface FlowGroup {
  readonly id: string;
  readonly label: string;
  /** The id of a drawn group, if any. */
  readonly parent?: string;
  /** 1 for a top-level group. */
  readonly depth: number;
}
export interface FlowchartModel {
  readonly direction: 'down' | 'right';
  /** `height` as written, when it is a finite number. */
  readonly height?: number;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly groups: readonly FlowGroup[];
  /**
   * Per type, set only when that type's limit cut parts: how many there were
   * before the cut (the outline's "100 of 130 nodes"). Nodes and groups count
   * valid, unrepeated parts; edges count edges whose two ends are kept nodes.
   */
  readonly cut: {
    readonly nodes?: number;
    readonly edges?: number;
    readonly groups?: number;
  };
  readonly findings: readonly string[];
}

/** Never throws; `props` is a Flowchart element's props, evaluated or as parsed. */
export const readFlowchart = (props: unknown): FlowchartModel;
```

**What a part is.** An entry of `nodes`, `edges` or `groups` that is an object with `type === 'element'`, the matching `typeName` and a `props` object whose required fields are strings. lang-core passes parts this way (`node_modules/@openuidev/lang-core/dist/index.d.mts:158-176`); measured with react-lang's `Renderer` (M1), the component receives `{ type: 'element', typeName: 'Node', props: { id, label, … }, partial }`. Any other entry is skipped without a finding: it is lang-core's own `missing-required` or `type-mismatch` at close (M1). An optional field with a value outside its schema reads as its default, without a finding: while streaming lang-core passes such a value through (M1, `shape: "hexagon"`), and at close it drops it and reports `type-mismatch` itself. `partial` is not read: it is `true` on every element of a parse whose input ends inside a line, including elements of earlier complete lines (M1), so it does not tell a complete part from an incomplete one.

**Steps and findings, in order.** Findings are appended in step order, parts in program order. Each finding is one sentence ending with a period. In the texts below, `<x>` stands for a value: `<id>`, `<parent>`, `<group>`, `<from>`, `<to>` and `<missing>` are ids written as `JSON.stringify` writes them, after an id longer than 24 characters is shortened to its first 23 characters followed by `…`, so the `…` is inside the quotes (`"abcdefghijklmnopqrstuvw…"`) and escaping comes after shortening; `<N>` is a count.

1. **Groups.** An id of 0 or more than 64 characters: `Group <id> is not drawn because an id has 1 to 64 characters.` A repeated id: `Group <id> appears twice, and only the first is drawn.` Of the rest, the first 25 are kept; beyond: `The Flowchart has <N> groups, and only the first 25 are drawn: split the diagram.`
2. **Parents.** A `parent` that names no kept group: `Group <id> names no Group <parent> as parent, so it is drawn at the top level.` Each group on a parent loop: `Group <id> is in a parent loop, so it is drawn at the top level.` A group whose depth would exceed 4: `Group <id> nests deeper than 4 levels, so it is drawn at the top level.` Each loses its parent. In this order: first every `parent` that names no kept group; then the loops of what remains, where a group naming itself is a loop of one, and every group on a loop (not those that only lead into one) loses its parent; then depths, from the top-level groups down, each level in program order, so that a group that moves to the top level takes its subtree with it: in a chain of six, the fifth moves and the sixth then has depth 2. Each of the three kinds of finding is written in program order, the kinds in this order. A child may be written before its parent.
3. **Nodes.** As step 1 with `Node`, `nodes` and the limit 100. A `group` that names no kept group: `Node <id> names no Group <group>, so it is drawn outside any group.`
4. **Empty groups.** A kept group whose subtree holds no kept node: `Group <id> holds no node, so it is not drawn.` Its child groups are removed with it, each with its own finding.
5. **Edges.** A `from` or `to` that names no kept node: `Edge <from>→<to> names no Node <missing>, so it is not drawn.` `<missing>` is the first end that names no kept node. Of the rest, the first 200 are kept; beyond: `The Flowchart has <N> edges, and only the first 200 are drawn: split the diagram.` Self-loops and repeated edges are drawn (ELK lays out both, M4).
6. **Labels.** A label longer than 120 characters is cut to its first 119 characters followed by `…`: `The label of Node <id> is cut at 120 characters.` (and `of Group <id>`, `of Edge <from>→<to>`). Counting code points, a cut never splits a surrogate pair. An empty node or group label draws the id; an empty edge label draws nothing.
7. **Empty diagram.** No kept node: `The Flowchart has no nodes.`

The drawn parts are therefore unique keys, existing endpoints and a tree of groups, which is all the layout accepts (F6).

**Props that are not literals.** A `$variable` or an expression in a part's prop is a string in the evaluated props the component reads and an AST node in the parse the check reads. The check then skips that part without a finding while the drawing draws it. The skill never asks for such props (F10); this case is accepted.

### F3. Findings in the check

`src/client/diagram/check.ts` exports:

```ts
/** One `runtime-error` per statement with diagram findings, in walk order. */
export const diagramCheck: (root: unknown) => readonly ReportedError[];
/** `errors` with each diagram error merged into the first `runtime-error` of its statement, or appended. */
export const mergeDiagramErrors: (
  errors: readonly ReportedError[],
  diagram: readonly ReportedError[],
) => readonly ReportedError[];
```

In `src/client/check.ts`, today's body of `programCheck` (`:57-94`) becomes an internal `ownErrors(revision, parsed)`; `programCheck` returns `mergeDiagramErrors(ownErrors(revision, parsed), diagramCheck(parsed?.root))`; `check` (`:122-128`) returns `mergeDiagramErrors([...ownErrors(revision, parsed), ...questionCheck(view, revision)], diagramCheck(parsed?.root))` from one parse. The card's list is `programCheck`'s (`renderer.ts:144`), the report's is `check`'s (`renderer.ts:86`).

- **Walk.** It visits the parsed root and every value under it: arrays, element props and nested elements. The _statement_ of an element is its own `statementId`, else that of the nearest enclosing element that has one, else `root`. lang-core sets `statementId` on elements defined as statements and leaves it undefined on inline calls (`index.d.mts:160-161`).
- **Flowcharts.** For each `Flowchart` element, `readFlowchart(element.props).findings`, attributed to the `Flowchart`'s statement. The parts the skill writes are inline calls in the lists `nodes`, `groups` and `edges` (F10), which carry no `statementId`, so a part's finding is reported on the `Flowchart`'s statement and not on the list the agent patches. Each text starts with the part's type (`Node`, `Group`, `Edge`) or names the Flowchart, and skill rule 2 puts each type in one list, so the text tells the agent which list to rewrite.
- **Parts outside.** A `Node`, `Edge` or `Group` element with no enclosing `Flowchart`: `Node draws only inside a Flowchart.` (`Edge`, `Group`), attributed to its statement. lang-core accepts such a part (M5).
- **One line per statement.** The findings of one statement, in walk order, become one error `{ code: 'runtime-error', statementId, message }`. One line per statement is required: the error card keeps the first line of each code and statement (`src/contracts/report.ts:92-98`), and the host lists one line per fence tag, fence key, code and statement (`src/host/validation.ts:204-213`).
- **The message.** `Diagram problems (<N>): ` followed by the numbered findings, each as `<i>. <finding>` and separated by a space: `Diagram problems (2): 1. Node "api" appears twice, and only the first is drawn. 2. Edge "api"→"db" names no Node "db", so it is not drawn.` The reporter cuts any message longer than 300 UTF-16 code units (`report.ts:191-194`), which would drop later findings without a count. The check therefore builds the message to fit its room, 300 code units for a line of its own: it adds findings in order while there is room for them and for a closing ` <K> more not shown.`, and ends with that sentence when `K` findings were left out. When not even the first finding fits (an escaped id can take six code units per character), the message is `Diagram problems (<N>): <N> more not shown.` The agent sees `N`, the first findings and how many are missing; after it fixes those, the next revision reports the rest.
- **Merging.** When the list already holds a `runtime-error` of the same statement, `mergeDiagramErrors` appends the diagram message to the first such error's message after `; ` instead of adding a line, so neither is lost to the one-line-per-statement rule; its room is then 300 code units minus the existing message and the separator, and when even `Diagram problems (<N>): <N> more not shown.` does not fit, the reporter's cut drops the diagram text. The errors that can share a statement: `@OpenUrl` and an `AskForm` off the root from `programCheck` (`check.ts:71-92`), the first before the second, as [The conversation's check and map](conversation-openui.md#the-conversations-check-and-map) describes; and in `check`'s list, `questionCheck`'s refusal or invalid question on `root` (`check.ts:17-18,103-118`), up to 300 code units. Skill rule 2 puts a `Flowchart` in its own statement, so the merge is a guard and not the usual path. A `runtime-error` that OpenUI itself reports on a statement with diagram findings is not merged: the card and the report list the check's lines before OpenUI's (`src/contracts/report.ts:57-63,136-144`), and the card and the host keep the first line per code and statement (`report.ts:92-98`, `src/host/validation.ts:204-213`), so OpenUI's is hidden (FR5).
- **One parse.** `programCheck` and `check` each parse the program once with `parseProgram` (`check.ts:39-50`) and pass the result to `toolStatements` and `diagramCheck`; a program that does not parse gives no diagram findings (OpenUI reports it).
- **Streaming.** The card is not drawn and nothing is reported while the fence streams, as today (`src/client/chunks/renderer.ts:138-148`, `report.ts:134`). The texts of `validation.ts` (`FIXED_TEXT`, `:26-45`) and `openui.programs/v1` do not change: every finding carries its own message.
- **Not reported.** A layout that rejects and a layout chunk that does not load are shown in the diagram (F4) and never reported, as the concept decides ([Errors in diagrams](../features/openui-diagrams.md#errors-in-diagrams)).

Example: `chart = Flowchart(nodes, edges)` with a repeated node `"api"` and `Edge("api", "db")` where no node is `"db"` reports `chart: runtime-error Diagram problems (2): 1. Node "api" appears twice, and only the first is drawn. 2. Edge "api"→"db" names no Node "db", so it is not drawn.`

### F4. Streaming, the outline and the states

**The fence context.** `ConversationFence` already provides `FenceContext` around `Renderer` with the fence's `view` and `revision` (`src/client/question/fence-context.ts:12-18`, `renderer.ts:150-153,167-169`). `FenceContextValue` gains two fields:

```ts
export interface FenceContextValue {
  // … view, revision, superseded, services, watchAnswers as today
  /** The diagram is interactive (Terms): `blockedReason(view, latest)` gives undefined. */
  readonly interactive: boolean;
  /** The window's layout loader (F6). */
  readonly layout: (graph: LayoutGraph) => Promise<LayoutResult>;
}
```

`ConversationFence` sets them in its memoized context (`renderer.ts:150-153`) from `blockedReason(view, latest)` (`:219-234`) and its `layout`. `ConversationFenceProps` (`renderer.ts:45-57`) gains the seam for tests and stories:

```ts
  /** The layout the fence's diagrams use; the window's layout loader (F6) when absent. */
  readonly layout?: (graph: LayoutGraph) => Promise<LayoutResult>;
```

The entry renders `ConversationFence` without it (`src/client/fence-element.tsx`), so the app always uses the window's loader. `tests/client/support/fence.ts`'s `FenceProps` gains the same optional `layout` and passes it through; tests that draw a diagram pass a fake that resolves, rejects or settles late, and FT3–FT7 call the real chunk module directly. A test therefore never makes the module's loader keep a rejected load. The streaming state is `view.fence.state === 'streaming'`, read from the same context. The component does not use react-lang's `useIsStreaming`: it returns the renderer's `blocked`, which is `isStreaming || !bundle.complete || !!bundle.error` (`bundles/features/openui/node_modules/@openuidev/react-lang/dist/index.mjs:185-187`, the context's `isStreaming` set to `blocked` at `:903`, defined at `:583`), a state broader than the fence's.

**States of `FlowchartView`**, the `Flowchart` renderer in `src/client/diagram/flowchart.tsx`. It reads `model = readFlowchart(props)` on every render and calls its hooks unconditionally.

| Condition                                  | Shows                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| No fence context (outside a conversation)  | The outline and the note "Diagrams are drawn only in the conversation."                                 |
| `streaming`                                | The outline and the note "The diagram is drawn when its fence is complete."                             |
| Not streaming, no drawn node               | The outline; the check reports `The Flowchart has no nodes.`                                            |
| Not streaming, layout pending              | The outline and the note "Drawing the diagram…"                                                         |
| Not streaming, layout or chunk load failed | The outline and the note "This diagram could not be drawn: <the error's message, first 200 characters>" |
| Not streaming, laid out                    | The picture (F7); the outline stays in the DOM as visually hidden text (`sr-only`)                      |

A failed layout and a layout chunk that did not load are shown alike, as the entry shows a renderer chunk that did not load ("The UI renderer did not load: <message>", `src/client/fence-element.tsx:33-41,136-143`), and are not reported to the agent (F3).

A patch revision that streams shows the outline of the merged program, which holds only the patch's completed lines (D5); the earlier revision's fence keeps its picture. An `unterminated` fence is laid out from its completed lines and is static (Terms, interactive).

**The outline.** `src/client/diagram/outline.tsx`, scrolling within a bounded height while visible:

- A header: `Flowchart: 5 nodes, 4 connections, 3 groups`. Singular for 1 (`1 node`); `, K groups` only when K > 0; when a limit cut parts of a type, `100 of 130 nodes` (from `cut`), so an edge dropped for a missing end never shows as "of". The outline's root element has an id from React's `useId`, which the SVG's `aria-describedby` names, so ids stay unique across fences.
- Up to three lists, each a `<ul>` labelled `Nodes`, `Groups` or `Connections`, with an item per drawn part in program order, omitted when empty: a node's label, then ` (in <group label>)` when grouped; a group's label, then ` (in <parent label>)`; a connection `<from label> → <to label>`, `—` in place of `→` when `arrow` is `none`, ` (dashed)` when dashed, then `: <label>` when labelled.
- The note of the state table.

While streaming, an edge whose ends are not both drawn nodes yet is not listed, because F2 does not draw it. Labels grow as the agent writes them: lang-core closes a pending string (M1). An edge to a node whose id is a prefix of a longer id may appear for one chunk and leave at the next; accepted (FR3).

**When layout runs.** An effect keyed by the JSON of the model's drawn parts and direction runs when the state is "not streaming" with at least one drawn node: it waits for the faces the labels need (F5), sizes the boxes (F5) and calls `layout(graph)` from the fence context. A result or failure that arrives after the key changed or the component unmounted is dropped, by a `live` flag the effect's cleanup clears, as the entry does for its chunk load (`src/client/fence-element.tsx:76-93`). A model therefore lays out once per mount, as the concept asks ("once when it mounts", [Where and when layout runs](../features/openui-diagrams.md#where-and-when-layout-runs-p10)).

**When a fence mounts.** The conversation keeps one fence element per fence tag and key across the editor's rebuilds (`FenceElements.take` and `give`, `bundles/desktop/chat/src/client/components/organisms/conversation/nodes/fence-node.tsx:1-6,102-139`), so a fence does not remount while it streams or while its Thread stays shown. Showing another Thread disposes every fence element of the conversation (`dispose`, `fence-node.tsx:141-145`), and showing the Thread again creates them anew. The conversation does not virtualize its blocks: it lays them out even off-screen (`bundles/desktop/chat/src/client/styles.css:184-189`). Opening or showing a Thread therefore lays out every closed `Flowchart` revision in it, in mount order; FR6 gives the cost.

### F5. Measuring and sizing

`src/client/diagram/measure.ts`:

```ts
/** A label as drawn: its lines and the size they take, in px, unpadded. */
export interface TextBlock {
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
}
/** The width in px of one line of text in the diagram font. */
export type Measure = (text: string) => number;
/**
 * Loads the faces `text` needs in the diagram font, then measures in it; the
 * per-character estimate where there is no canvas 2D context.
 */
/** Font size, weight and line height, and the node, edge-label and group paddings, in px. */
export const DIAGRAM_METRICS: { readonly groupPadding: number /* … */ };
export const createMeasure: (text: string) => Promise<Measure>;
/** `label` wrapped to `maxWidth` on spaces, and inside a word wider than a line. */
export const wrapLabel: (
  label: string,
  maxWidth: number,
  measure: Measure,
) => TextBlock;
/** What graph.ts and the drawing take from measuring, in the model's order. */
export interface Sizes {
  readonly nodes: readonly {
    readonly label: TextBlock;
    readonly width: number;
    readonly height: number;
  }[];
  readonly groups: readonly {
    readonly label: TextBlock;
    readonly minWidth: number;
  }[];
  /** The padded label box of each edge, if labelled. */
  readonly edges: readonly (
    | {
        readonly label: TextBlock;
        readonly width: number;
        readonly height: number;
      }
    | undefined
  )[];
}
export const sizeModel: (model: FlowchartModel, measure: Measure) => Sizes;
```

The wrapped lines travel from measuring to drawing in `Sizes`; the layout result carries boxes only.

- **The font.** Labels are drawn and measured in the conversation's face: the family is the value of `--font-conversation` (`packages/desktop/src/styles/tokens.css:80`, IBM Plex Mono, which every conversation block wears, `bundles/desktop/chat/src/client/components/organisms/conversation/nodes/conversation-font.ts:1-7`), read from `getComputedStyle(document.documentElement)` at measuring time, with `'IBM Plex Mono', monospace` when it is empty; the size and weight are constants of `measure.ts`. The SVG's text sets `font-family: var(--font-conversation)` and the same size and weight. No element of the diagram is needed to measure, so measuring runs while the outline is shown.
- **Fonts.** `createMeasure` first calls `document.fonts.load(font, text)` with that font and the model's labels joined into one string. `FontFaceSet.load` loads every face of the font whose `unicode-range` covers a character of `text` and resolves when they have loaded. `document.fonts.ready` would not be enough: it waits only for faces already requested, and a face no text on the page has used yet, such as IBM Plex Mono's Latin2 subset (`ő`, `ł`; `packages/desktop/src/styles/fonts.css:132-145`), has not been requested, so a label would be measured in the fallback face and drawn wider once its face loads. When `load` rejects, measuring goes on with the faces present; where `document.fonts` does not exist (happy-dom has none), the step is skipped.
- **Measure.** A canvas 2D context in that font. Where no 2D context exists (happy-dom), the width is the label's length in characters times a constant, so the tests are deterministic.
- **Wrap.** Node and edge labels wrap to a maximum text width per shape. `diamond` and `circle` have a smaller maximum than the other shapes, because their box grows faster than the label (below); FT17 asserts that a label which fits on one line in a `box` takes at least two lines in a `diamond`. Group labels do not wrap.
- **Boxes.** Each node box is sized so the wrapped label, padded, fits inside its shape: for `diamond` and `circle` the box is the smallest diamond or circle that contains the padded label rectangle; `cylinder` adds the height of its caps. Edge label boxes are the padded label. A group's minimum width is its label's width plus the group's side paddings (F6).
- The constants (font size and weight, line height, paddings, maximum widths, the estimate per character) are code, checked by FT17.

### F6. The layout chunk and the layout loader

**Types.** `src/client/diagram/layout-types.ts`, imported with `import type` by the chunk and the renderer side, so the split test counts no shared module (`tests/client-split.test.ts:1-8,23-67`):

```ts
export interface LayoutGraph {
  readonly direction: 'down' | 'right';
  /** Every group's padding in px: `top` (label line height plus group padding), `side` on the other sides. */
  readonly groupPadding: { readonly top: number; readonly side: number };
  /** Keys are unique across nodes, groups and edges. */
  readonly nodes: readonly {
    readonly key: string;
    readonly width: number;
    readonly height: number;
    /** The key of the group that holds the node. */
    readonly group?: string;
  }[];
  /** In any order; the parents form a forest. */
  readonly groups: readonly {
    readonly key: string;
    /** The key of the enclosing group. */
    readonly parent?: string;
    readonly minWidth: number;
  }[];
  readonly edges: readonly {
    readonly key: string;
    /** Node keys. */
    readonly from: string;
    readonly to: string;
    readonly label?: { readonly width: number; readonly height: number };
  }[];
}
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface LayoutResult {
  readonly width: number;
  readonly height: number;
  readonly nodes: Readonly<Record<string, Box>>;
  readonly groups: Readonly<Record<string, Box>>;
  /** `points`: start, bends, end, with no two equal in a row. */
  readonly edges: Readonly<
    Record<string, { readonly points: readonly Point[]; readonly label?: Box }>
  >;
}
```

`src/client/diagram/graph.ts` exports `toLayoutGraph(model: FlowchartModel, sizes: Sizes): LayoutGraph`: node `i` is key `n<i>`, group `i` is `g<i>`, edge `i` is `e<i>`, in the model's order; `group`, `parent`, `from` and `to` hold these keys, never the agent's ids.

**The chunk.** `src/client/chunks/layout.ts` is built as its own file because `packages/bundle` builds every `src/client/chunks/*.ts` (`packages/bundle/src/build/parts.ts:414-432`); `elkjs` is not an import-map specifier (`packages/bundle/src/build/externals.ts:10-25`), so it is bundled into the chunk. It imports `elkjs/lib/elk.bundled.js` and no relative module by value, and exports one function:

```ts
export const layout: (graph: LayoutGraph) => Promise<LayoutResult>;
```

**Import.** The default import of `elkjs/lib/elk.bundled.js` is cast to `new () => ELK`, with `ELK` the type of `elkjs/lib/elk-api.js`: under the repository's `module: nodenext` (`tsconfig.base.json:9-10`) the default import of this CommonJS file is typed as the module object and `new` on it does not compile, while at run time Node's and esbuild's default import is the constructor (M4). The chunk makes one `ELK` instance, at its first `layout` call, and keeps it for the window's life: constructing one posts a `register` message through the fake worker (`elk.bundled.js:23-62`), which A2's times then include once, not per layout.
**ELK graph.** The root holds the top-level groups and top-level nodes, each group its child groups and nodes, in graph order; every edge is declared on the root. Root options, as in the concept's measurement:

| Option                  | Value              |
| ----------------------- | ------------------ |
| `elk.algorithm`         | `layered`          |
| `elk.direction`         | `DOWN` or `RIGHT`  |
| `elk.hierarchyHandling` | `INCLUDE_CHILDREN` |
| `elk.edgeRouting`       | `ORTHOGONAL`       |
| `elk.randomSeed`        | `1`                |
| `elk.json.shapeCoords`  | `ROOT`             |
| `elk.json.edgeCoords`   | `ROOT`             |

**Group options.** `elk.padding`: on the top, the group label's line height plus the group padding; on the other sides, the group padding, both read from the graph's `groupPadding`, which `graph.ts` fills from F5's `DIAGRAM_METRICS` (the chunk does not import `measure.ts` by value, FT9); `elk.nodeSize.constraints` `MINIMUM_SIZE`; and `elk.nodeSize.minimum` `(minWidth, 48)` for `right` and `(48, minWidth)` for `down`. The pair is swapped for `down` because ELK applies a compound node's minimum in its direction-relative frame: measured in 0.11.1 and 0.12.1 (M4), `(260, 48)` under `DOWN` gives a group 84 wide and 260 tall, and `(48, 260)` gives 260 wide. FT5 fails if an ELK change breaks this. An edge label is an ELK edge label of the label box's size.

**Result.** Boxes from the laid-out children (absolute coordinates), each edge's points from its sections' start, bend and end points, the label box from its first label, and the root's size. ELK's internal `$H` numbers, which differ between runs, are not copied.
**Errors.** A graph with a repeated key, a reference to a missing key or a loop of group parents rejects with `Error('Invalid layout graph: <first problem>')` before ELK runs; F2 makes this unreachable from a `Flowchart`. An ELK exception rejects with ELK's error.
**Measured** (M4): on the fixtures 20/28/4/2, 50/70/none, 50/70/10/3 and 100/200/25/4, 5 seeds each, in both directions, with these options, group minimum widths and 30 % of edges labelled, both versions gave zero defects of G3 (a), no group narrower than its label, and the same geometry for the same input; the slowest layout took 52 ms at 20 nodes, 72 ms at 50 and 217 ms at 100, in Node with 0.11.1.

**The loader.** `src/client/diagram/layout-loader.ts`:

```ts
export type LayoutModule = {
  readonly layout: (graph: LayoutGraph) => Promise<LayoutResult>;
};
/** Calls `load` at the first layout and never again; a rejected load rejects that call and every later one. */
export const createLayoutLoader: (
  load: () => Promise<LayoutModule>,
) => (graph: LayoutGraph) => Promise<LayoutResult>;
```

- **No queue and no cache.** Layouts never overlap: `elk.bundled.js` runs ELK in-process through a fake worker whose `postMessage` schedules one `setTimeout` task that runs the whole layout synchronously (`node_modules/elkjs/lib/elk.bundled.js:6429`, 0.11.1), so each layout is one main-thread task, and the window handles input and paints between two of them. A model lays out once per mount (F4), and a late result is dropped by the component, not by the loader. Whether the layouts of a Thread the reader has left must be skipped is decided by A2 (FR6).
- **A chunk that does not load.** The rejected load is kept, as the renderer chunk's loader keeps its own (`createChunkLoader`, `src/client/folds.ts:20-40`): every later layout rejects with the same error, and each diagram shows it in the failed state of F4. A new window loads the chunk again.
- **One per window.** The renderer chunk is imported once per window (`chunkLoader`, `src/client/folds.ts:48-55`), and a module is evaluated once per window, so the loader made at module level in `renderer.ts` is the window's only one.

`renderer.ts` makes the window's loader once, at module level, so the chunk's URL is resolved from `renderer.ts`'s own location, as `folds.ts:45-55` does for the renderer chunk:

```ts
type LayoutChunk = typeof import('./layout.js');
const layoutLoader = createLayoutLoader(
  () =>
    import(
      new URL('./layout.js', import.meta.url).href
    ) as Promise<LayoutChunk>,
);
```

The import is written in `renderer.ts` and not under `src/client/diagram/`, because the URL is relative to the importing module: in the build `renderer.ts` becomes `client/chunks/renderer.js` beside `client/chunks/layout.js`, and in the tests `tsc` emits `dist-tests/src/client/chunks/renderer.js` beside `dist-tests/src/client/chunks/layout.js`, which imports `elkjs` from `node_modules`; so the client tests run the real ELK.

### F7. Drawing

`src/client/diagram/canvas.tsx` draws a laid-out model, and `outline.tsx`, `geometry.ts` and `colors.ts` serve it:

```ts
// canvas.tsx
export function DiagramCanvas(props: {
  readonly model: FlowchartModel;
  readonly sizes: Sizes;
  readonly result: LayoutResult;
  readonly interactive: boolean;
  /** The outline's id, for `aria-describedby`. */
  readonly outlineId: string;
}): ReactNode;
// outline.tsx
export function Outline(props: {
  readonly model: FlowchartModel;
  readonly note?: string;
  /** Visually hidden (`sr-only`) once the picture is drawn. */
  readonly hidden: boolean;
  readonly id: string;
}): ReactNode;
// geometry.ts
/** `points` with its first (`at: 'start'`) or last segment extended to the outline of a `diamond` or `circle` box; unchanged for other shapes. */
export const endOnShape: (
  points: readonly Point[],
  at: 'start' | 'end',
  shape: NodeShape,
  box: Box,
) => readonly Point[];
// colors.ts
export type ColorRole =
  | 'nodeFill'
  | 'nodeStroke'
  | 'nodeText'
  | 'edge'
  | 'edgeText'
  | 'labelPlate'
  | 'group1'
  | 'group2'
  | 'group3'
  | 'group4'
  | 'groupStroke'
  | 'groupText';
/** A Doric token, or `--foreground` mixed over `--background` at `mix` percent. */
export type ColorValue = { readonly token: string } | { readonly mix: number };
export const DIAGRAM_COLORS: Readonly<Record<ColorRole, ColorValue>>;
/** The CSS color of a value: `var(--token)` or `color-mix(in srgb, var(--foreground) p%, var(--background))`. */
export const cssColor: (value: ColorValue) => string;
```

`FlowchartView` passes the model, the `Sizes` of F5, the result and `interactive` from the context; FT16 reads `DIAGRAM_COLORS`, FT17 calls `wrapLabel`, `sizeModel` and `endOnShape` and renders `DiagramCanvas` with a fixed `LayoutResult`.

- **Structure.** The area (`div`, full width, clipped, the height below; focusable and labelled "Flowchart, pan and zoom" only when interactive) holds a content `div` with the viewport's CSS transform (`viewportTransform`), which holds one `svg` the size of the layout result. The SVG is `role="img"`, labelled with the outline's header and described by the outline. In paint order: groups from the outermost, edges, nodes, edge labels; edges under nodes so that their ends tuck under the shapes. The toolbar (F8) sits over the area's top right when interactive.
- **Shapes.** `box`: a rectangle with slightly rounded corners; `round`: a rectangle whose corners are rounded by half its height (a stadium); `diamond`: a four-point polygon touching the middle of each side of its box; `circle`; `cylinder`: walls with an elliptic cap at the top and bottom. Each has its label lines centered.
- **Edges.** A path through the result's points; dashed when `line` is `dashed`; an arrowhead marker at the end when `arrow` is `end`. ELK ends edges on the bounding box; for a `diamond` or `circle` end the end segment is extended along its direction to the shape's outline (`src/client/diagram/geometry.ts`, pure), so the arrow touches the shape. Edge labels sit on a plate at their label box.
- **Groups.** A rounded rectangle with its label in the top padding. FT5 guarantees the group is wide enough for its label, so group labels are not cut beyond F2's 120 characters and need no tooltip.
- **Colors.** `src/client/diagram/colors.ts` gives each role as data: a Doric token, or a `color-mix(in srgb, …)` of `--foreground` over `--background` at a fixed percentage. Node fill and edge label plate: `--background`; node, edge and group text: `--foreground`; node strokes and edges: `--muted-foreground`; group fills: four mixes of increasing strength by depth, and a stronger mix for group strokes. Every token used is hex in both of Doric's variants (`packages/desktop/src/styles/tokens.css:5-16,100-111`), and an sRGB mix is linear in gamma-encoded channels, so FT16 computes every color exactly from `tokens` and `resolvedVariables` of `desktop/ui` (`packages/desktop/src/tokens/css.ts:33-40`) and requires text ≥ 4.5 : 1 on every fill it sits on and strokes and edges ≥ 3 : 1 on every fill they cross, in both variants. The theme's chart colors are not used. A theme switch repaints through the variables, with no new layout.
- **Height of the area.** When `height` is written: `height` clamped to 160–1200 px. Otherwise the drawing's height at the scale that fits the area's width, plus the fit margin, clamped to 160–560 px, computed when the result arrives and not again on resize.
- **Text.** Labels are React text nodes; no prop becomes markup, a URL, a style or an attribute name (concept R8).

### F8. Pan and zoom

`src/client/diagram/gestures.ts` exports `useDiagramViewport(area, content, interactive)`, which pans and zooms as papercraft's canvas node does in the conversation and returns the viewport, its percentage, and `zoomIn`, `zoomOut` and `fit`. Its math is `desktop/ui/viewport` (F9).

- **Fitted.** The viewport starts as the fit of the content in the area. While the reader has not panned or zoomed since the last fit, it fits again whenever the area's size changes.
- **Static (UD8, P14).** When `interactive` is false: no listeners, no `tabIndex`, no toolbar, and the viewport is the fit; when `interactive` turns false, which happens only when a newer revision of the same fence arrives (Terms), the viewport returns to the fit. While a click of the same fence is sending, the renderer's wrapper is `inert` (`renderer.ts:322`) and input does not reach the area, but `interactive` stays true: the toolbar stays drawn, the viewport keeps its pan and zoom, and nothing refits (Terms). The renderer's `inert` wrapper (`renderer.ts:163,322`) does not change.
- **Focus.** A primary-button `pointerdown` focuses the area; Escape on it blurs it. Focus plays the part of the "clicked" state of papercraft's wheel rule: a canvas node in the conversation ([papercraft-openui.md](papercraft-openui.md)) takes a plain wheel only after the reader clicked it, and otherwise leaves it to the conversation's scroll (`bundles/features/papercraft/src/client/surface/gestures.ts:411-418`). Losing focus gives the wheel back to the conversation.
- **Drag.** A pointer drag on the area pans it.
- **Wheel.** One non-passive listener asks `wheelGesture` (F9) with `zoom: ctrlKey || metaKey` and `captured: document.activeElement === area`. No gesture: the conversation scrolls. Otherwise the default is prevented and the viewport zooms at the pointer or pans. Trackpad pinch arrives in Chromium as a wheel event with `ctrlKey` and zooms.
- **Buttons.** "Zoom out", the percentage, "Zoom in" (by `ZOOM_STEP` at the area's center) and "Fit to view", with `lucide-react` icons, already a dependency of `openui`. Scale stays within 25–400 % (`clampScale`).

### F9. Shared viewport helpers

**New module** `packages/desktop/src/viewport.ts`, exported as `./ui/viewport` in `packages/desktop/package.json` beside `./ui/svg-mask` (`:74-79`). `app/desktop/doric-platform/build.mjs:173-198` turns every `./ui/*` subpath into a `desktop/ui/<name>` import-map entry, so no build change is needed; `desktop/ui/*` is a client external (`externals.ts:19-20`) and both bundles already depend on `desktop` (`bundles/features/openui/package.json`, `bundles/features/papercraft/package.json:21`).

It holds, moved unchanged from `bundles/features/papercraft/src/client/surface/viewport.ts:13-104`: `Viewport`, `IDENTITY`, `clampScale`, `ZOOM_STEP`, `zoomAt`, `ContentBounds`, `fitViewport`, `zoomPercent`, `toContent`, `viewportTransform`. It adds the wheel rule of `gestures.ts:398-437` as a pure decision:

```ts
export interface WheelGestureInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
  /** Ctrl or ⌘ held, or a trackpad pinch. */
  readonly zoom: boolean;
  /** The surface takes a plain wheel: it was clicked (focused), or it always does. */
  readonly captured: boolean;
  /** The surface's height in px; 0 counts as 800. */
  readonly pageHeight: number;
}
export type WheelGesture =
  | { readonly kind: 'zoom'; readonly factor: number }
  /** Added to the viewport's translation: `-deltaX` and `-deltaY`, scaled. */
  | { readonly kind: 'pan'; readonly dx: number; readonly dy: number };

/** `undefined` when the wheel is the page's: no zoom and not captured. */
export const wheelGesture: (
  input: WheelGestureInput,
) => WheelGesture | undefined;
```

`zoom` gives a zoom of 1.1 in or out by the sign of `deltaY`, captured or not. Otherwise, captured gives a pan of `dx = −deltaX × s` and `dy = −deltaY × s`, with `s` 1, 16 or `pageHeight` by `deltaMode` as `deltaScale` does today; papercraft subtracts the scaled deltas from its translation today (`gestures.ts:397-399,430-434`), which is the same move.

**Papercraft.** `src/client/surface/viewport.ts` keeps its header comment and the grid helpers (`:106-154`) and replaces `:13-104` with a re-export of the same names from `desktop/ui/viewport`, plus a type import of `Viewport` for the grid helpers (a re-export binds no local name), so its twelve importers do not change: under `src/client/surface/`, `preview-container.tsx:94`, `controller.ts:21`, `gestures.ts:48` and `fit.ts:20`, and the type-only imports of `thread-popover.tsx:37`, `pins-layer.tsx:37`, `overlays.tsx:9` and `comment-overlay.tsx:18`; the stories `stories/support/frame.tsx:7`, `stories/surface/pins-layer.stories.tsx:8` and `stories/surface/thread-popover.stories.tsx:12`; and `tests/client/viewport.test.ts:20`. Its `wheel` (`gestures.ts:411-437`) keeps its first rule, that a plain wheel over an open comment thread scrolls that thread (`:412-413`), and calls `wheelGesture` with `captured: input.chrome !== 'node' || input.focusedRef.current` (a canvas outside the conversation always takes the wheel; the conversation's node takes it once clicked) and the wrapper's height, then applies the gesture as today: a zoom at `event.surface`, a pan by adding `dx` and `dy` to the translation. `deltaScale` (`:397-399`) leaves `gestures.ts`; papercraft's own `WheelInput` (`:401-409`), the type of `wheel`'s event with `surface`, `fromOverlay` and `preventDefault`, stays as it is, so the shared input type is named `WheelGestureInput` and the two never meet in one scope. `fit.ts` and `useCanvasGestures` stay in papercraft (concept P13). Papercraft's own wheel test (`tests/client/canvas-element.test.ts:1805-1830`) is the regression check.

### F10. Lists and the skill

**P4 settled: inline lists.** Measured (M2) on random graphs of the generator's variant, the token count of a first write and of a patch that adds one edge, in the inline form (`nodes = [Node(…), …]`) and in one statement per part (`n0 = Node(…)` with `chart = Flowchart([n0, …], [e0, …])`), with OpenAI's `o200k_base` tokenizer (`cl100k_base` within 1 %; Claude's tokenizer is not public):

| Nodes / edges / groups | Write, inline | Write, per part | Patch, inline | Patch, per part |
| ---------------------- | ------------- | --------------- | ------------- | --------------- |
| 5 / 4 / 3              | 153           | 213             | 41            | 56              |
| 20 / 28 / 4            | 561           | 861             | 229           | 176             |
| 50 / 70 / 10           | 1,470         | 2,238           | 612           | 411             |
| 100 / 200 / 25         | 3,732         | 5,670           | 1,886         | 996             |

The inline form costs 28–35 % fewer tokens to write; a per-part patch is cheaper from 20 nodes, but the per-part form recovers its larger first write only after 6 one-edge patches at 20 nodes, 4 at 50 and 3 at 100. Inline lists stay; a patch rewrites only the lists that change. A rewritten list can drop or alter parts the reader did not ask to change; no measurement covers that, so [Acceptance](#acceptance) adds patch prompts and FR10 names the risk.

**Rules.** Four rules are added after the ten Doric rules of `tests/client/skill-text.test.ts:37-59`, in this order. Each line below is one rule's exact text, backticks and quotes included:

```text
Draw structure and flow with a Flowchart: a process, a pipeline, how the parts of a system connect, or an architecture with regions (groups). Use a chart for numbers. Put a Flowchart at the root or in a Stack.
Write a Flowchart as statements in this order, each list on one line: `chart = Flowchart(nodes, edges, groups, "down")` right after root, then `nodes = [Node(…), …]`, `groups = [Group(…), …]` (`groups = []` when there are none) and `edges = [Edge(…), …]`. To change a diagram, patch only the lists that change, each written whole.
Ids have 1 to 64 characters and are unique among a Flowchart's nodes and among its groups. An Edge names two Node ids of its own Flowchart; a Node's group and a Group's parent name Group ids of the same Flowchart. Never give positions, sizes or colors: the app lays the diagram out.
A Flowchart holds at most 100 nodes, 200 edges and 25 groups nested at most 4 deep; labels are cut at 120 characters. Split anything larger into several diagrams.
```

The order `nodes` before `groups` keeps the `Flowchart` in the render while the groups stream (F1). The rules are option (a) of the concept ([The skill](../features/openui-diagrams.md#the-skill)): Doric rules in `additionalRules`; the components appear under "### Other" after the question built-ins (`src/host/skills/openui.md:171-174`), because `extend` takes no groups. The test's `generate` (`skill-text.test.ts:62-82`) adds `defineDiagramBuiltins(defineComponent, …)`'s four after the question built-ins in the order `Flowchart, Node, Edge, Group`, and `OPENUI_SKILL_UPDATE=1` rewrites `src/host/skills/openui.md`. Measured with these components and rules (M3): +637 characters of signatures and +995 of rules, 1,632 in all, against G6's 4,000.

### F11. elkjs and its license

- **Version.** `"elkjs": "0.11.1"` in `bundles/features/openui/package.json` `dependencies`, an exact pin as the OpenUI packages are. It is the version already in the lockfile as an exact dependency of `@prisma/studio-core` (`package-lock.json:9083`), so the repository keeps one copy. Measured against 0.12.1, the version the concept measured (M4, M6): zero defects of G3 (a) with both, the same direction-relative group minimum size, the same self-loop and parallel-edge results, the same CommonJS default export; slowest layout 217 ms with 0.11.1 and 232 ms with 0.12.1; built chunk 2,609,437 bytes against 2,669,154. Phase 1 uses no feature added after 0.11.1.
- **What Doric distributes.** The bundle's `dist` is staged into the host and shipped (`packages/bundle/src/build/cli.ts:306-327`). elkjs reaches it only inside `client/chunks/layout.js`, bundled and syntax-minified by esbuild and not otherwise modified (M6), in object form: the GWT output, not ELK's Java source. elkjs is under the EPL-2.0 (`node_modules/elkjs/package.json`, `"license": "EPL-2.0"`). `elk.bundled.js` also holds GWT's runtime and compiled classes of Google's Guava library (`com.google.gwt.core.client` and `com.google.common.base` at `elk.bundled.js:4213,6509`), which are under the Apache License 2.0 upstream; the elkjs package carries no notice or license file for them (its files are `LICENSE.md`, `README.md`, `lib` and `package.json`).
- **The notice.** esbuild removes ordinary comments, so a plain build drops ELK's two notices (`node_modules/elkjs/lib/elk.bundled.js:14-22,6530-6537`); it keeps comments that start with `/*!` and, for a bundle, moves them to the end of the file (esbuild's default `legalComments: 'eof'`; `packages/bundle` sets none, `parts.ts:207-244`). Measured (M6): ELK's notices absent, a `/*!` comment of the entry present at the end. `src/client/chunks/layout.ts` therefore starts with this legal comment:

  ```text
  /*!
   * This file contains elkjs 0.11.1 (https://github.com/kieler/elkjs), the
   * JavaScript build of the Eclipse Layout Kernel (https://github.com/eclipse-elk/elk),
   * bundled and syntax-minified by esbuild and not otherwise modified by Doric.
   * elkjs is distributed here under the Eclipse Public License 2.0
   * (https://www.eclipse.org/legal/epl-2.0). Its Source Code is available under
   * that license at https://github.com/kieler/elkjs/tree/0.11.1 and
   * https://github.com/eclipse-elk/elk.
   *
   * <ELK's notice of elk.bundled.js lines 14-22, verbatim>
   *
   * <ELK's notice of elk.bundled.js lines 6530-6537, verbatim>
   *
   * Doric's own code in this file is under the MIT License.
   */
  ```

- **License texts: a separate change.** Shipping the full texts of third-party licenses is not part of this spec. The user decided (2026-11-06) that it is handled for the builds of all bundles by a separate change in `packages/bundle`, in the style of `copyLicenses` in `app/desktop/doric-platform/build.mjs:379-422`: each bundle's `dist` gets its own license and, under `licenses/`, the license file of every package bundled into its files. That change must also cover code a package bundles under another license than its own: `copyLicenses` finds packages from esbuild's metafile inputs (`build.mjs:392-397`), so for `elk.bundled.js` it would find only elkjs's EPL-2.0 `LICENSE.md`, not the Apache License 2.0 of the GWT and Guava code inside it. The EPL-2.0 copy of §3.2 (b) and the Apache License 2.0 copy of its §4 (a) are therefore addressed by that change. Order: neither the steps nor the release depend on it. Phase 1 may ship, as `openui` 2.2.0, before it (user, 2026-11-06); until it lands, releases carry the GWT and Guava code without the Apache License 2.0 text, an accepted risk (FR12).
- **What this rests on.** EPL-2.0 §3.1 (a) asks that the Program be made available as Source Code "in accordance with section 3.2" and that the copy carry a statement telling recipients how to obtain it; §3.3 asks that notices be kept (`node_modules/elkjs/LICENSE.md:102-139`). The chunk carries the statement and the notices. That pointing to the two upstream repositories counts as making the Source Code available is a reading, not a proven fact; FR11 records it as an accepted risk. §4 of the EPL does not apply: Doric is not a commercial product offering that distributes ELK (user, 2026-11-06). The user decided that no legal review is needed.
- **Check.** FT8 reads the built `dist/client/chunks/layout.js` and fails if the statement or either notice is missing, so a later bundler change cannot remove them silently. The `openui` README names elkjs, its license and the chunk ([Docs to update](#docs-to-update)).
- **CSP.** The packaged policy has no `'unsafe-eval'` (`app/desktop/doric/src/platform/protocol/csp.ts:13-26`). The built chunk of M6 contains no `new Function(` and no `eval(`; FT8 asserts both. Only a packaged build proves that nothing reaches an eval at run time (A2).

### F12. Versions and contracts

- **Rollback.** Going back from 2.2.0 to 2.1.0 removes the four components: Threads keep their fences, and a persisted `Flowchart` fence then draws OpenUI's `unknown-component` error card instead of a diagram. Nothing persisted changes, so going forward again draws them. Accepted.
- `openui` `manifest.json` `version` 2.1.0 → 2.2.0: components added, no contract changed. `description` gains "diagrams laid out by the app". `provides`, `requires` and `desktopScope` do not change.
- `openui.programs/v1`, `openui.questions/v1`, `openui.answered/v1`, `chat.views/v1` and the `openui/contracts` module are unchanged; diagram findings use the existing `runtime-error` code with a message.
- `papercraft` (`manifest.json` 2.1.0) is unchanged in behavior and contracts, so its version stays.
- `packages/desktop` (private, 1.0.0) gains a subpath; its version stays.

## Phases

Each step leaves `npx nx test bundle-openui`, `npx nx test bundle-papercraft`, `npx nx test desktop` and `npx nx typecheck bundle-openui` passing.

| Step | Lands                                                                                                                                                                                                                                                                                                                        | Tests      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1    | F9: `desktop/ui/viewport` with the moved helpers and `wheelGesture`; papercraft re-exports them and its wheel calls `wheelGesture`; tests moved. No behavior change.                                                                                                                                                         | FT1, FT2   |
| 2    | F1's definitions, F2, F5's measuring and sizing, F6 and F11: `diagram/definitions.ts`, `model.ts`, the `elkjs` dependency, `layout-types.ts`, `chunks/layout.ts` with its legal comment, `graph.ts`, `measure.ts`, `layout-loader.ts`, the test helper `random-graph.ts`. Nothing calls the loader or renders a diagram yet. | FT3–FT11   |
| 3    | F1's library entries, F3, and F4's streaming and outline: `diagram/check.ts`, `programCheck` and `check`, the four components in the library, `outline.tsx`, `FlowchartView`. With no layout yet, a `Flowchart` that is not streaming shows its outline and no note. The skill does not list the components yet.             | FT12, FT13 |
| 4    | F4's layout states, F7, F8, F10, F12: the fence context's two fields and the `layout` prop, the window's loader in `renderer.ts`, the layout effect, the drawing, gestures and toolbar, the stories, the skill rules and regenerated skill, `manifest.json` 2.2.0, the docs.                                                 | FT14–FT17  |

Phase 1 ships when the user accepts it after [Acceptance](#acceptance), as U48 rules for OpenUI's stages ([openui.md](openui.md#decisions-already-made)). There is no spike before step 1 (user, 2026-11-06), so the main-thread design is validated last, by A2.

**If A2 fails.** A2's exits are decided with the user after A2: lower the limits, or move layout off the main thread (a worker, and with it, if the second profile asks for it, a queue that skips the layouts of diagrams already unmounted). Either keeps `layout`, its types, `graph.ts`, F2–F5 and F7–F10, because both call the same function from the same loader interface; the packaged policy already allows `worker-src 'self'` (`app/desktop/doric/src/platform/protocol/csp.ts:17`). G4's ≤ 1 s for a window's first diagram is a target that A2 checks, not a measured figure: the browser's cost of evaluating the 2.6 MB chunk is not measured before A2.

**The license-files change.** The separate `packages/bundle` change of F11, which ships third-party license texts with every bundle and must cover the GWT and Guava code inside `elk.bundled.js`, is a follow-up, not a precondition: phase 1 may ship before it (user, 2026-11-06; FR12).

## Files to change

| File                                                                                                                                                       | Change                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/desktop/src/viewport.ts` (new)                                                                                                                   | F9: the moved helpers and `wheelGesture`                                                                                                                                                                                                                                                                                                               |
| `packages/desktop/package.json`                                                                                                                            | `./ui/viewport` export                                                                                                                                                                                                                                                                                                                                 |
| `packages/desktop/tests/viewport.test.ts` (new)                                                                                                            | FT1                                                                                                                                                                                                                                                                                                                                                    |
| `bundles/features/papercraft/src/client/surface/viewport.ts`                                                                                               | `:13-104` replaced by a re-export from `desktop/ui/viewport`                                                                                                                                                                                                                                                                                           |
| `bundles/features/papercraft/src/client/surface/gestures.ts`                                                                                               | `wheel` calls `wheelGesture`; `deltaScale` removed, `WheelInput` kept (F9)                                                                                                                                                                                                                                                                             |
| `bundles/features/papercraft/tests/client/viewport.test.ts`                                                                                                | FT2: keeps the grid test (`:102-134`); the tests of `:22-100` move to FT1                                                                                                                                                                                                                                                                              |
| `bundles/features/papercraft/tests/client/canvas-element.test.ts`                                                                                          | FT2: unchanged; its wheel test (`:1805-1830`) must pass                                                                                                                                                                                                                                                                                                |
| `openui` `package.json`, root `package-lock.json`                                                                                                          | `elkjs` 0.11.1 as a dependency of `openui`; the lockfile keeps its one copy                                                                                                                                                                                                                                                                            |
| `openui` `src/client/diagram/definitions.ts` (new)                                                                                                         | F1                                                                                                                                                                                                                                                                                                                                                     |
| `openui` `src/client/diagram/model.ts` (new)                                                                                                               | F2                                                                                                                                                                                                                                                                                                                                                     |
| `openui` `src/client/diagram/check.ts` (new), `src/client/check.ts`                                                                                        | F3                                                                                                                                                                                                                                                                                                                                                     |
| `openui` `src/client/question/fence-context.ts`                                                                                                            | `interactive` and `layout` (F4)                                                                                                                                                                                                                                                                                                                        |
| `openui` `src/client/diagram/outline.tsx` (new), `src/client/diagram/flowchart.tsx` (new)                                                                  | F4                                                                                                                                                                                                                                                                                                                                                     |
| `openui` `src/client/diagram/measure.ts` (new)                                                                                                             | F5                                                                                                                                                                                                                                                                                                                                                     |
| `openui` `src/client/diagram/graph.ts` (new), `layout-types.ts` (new), `layout-loader.ts` (new)                                                            | F6                                                                                                                                                                                                                                                                                                                                                     |
| `openui` `src/client/chunks/layout.ts` (new)                                                                                                               | F6, F11                                                                                                                                                                                                                                                                                                                                                |
| `openui` `src/client/diagram/canvas.tsx` (new), `geometry.ts` (new), `colors.ts` (new)                                                                     | F7                                                                                                                                                                                                                                                                                                                                                     |
| `openui` `src/client/diagram/gestures.ts` (new)                                                                                                            | F8                                                                                                                                                                                                                                                                                                                                                     |
| `openui` `src/client/library.ts`                                                                                                                           | F1: the four components added                                                                                                                                                                                                                                                                                                                          |
| `openui` `src/client/chunks/renderer.ts`                                                                                                                   | the window's layout loader; the optional `layout` prop; the context's two fields (F4, F6)                                                                                                                                                                                                                                                              |
| `openui` `src/host/skills/openui.md`                                                                                                                       | regenerated (F10)                                                                                                                                                                                                                                                                                                                                      |
| `openui` `manifest.json`                                                                                                                                   | 2.2.0, description (F12)                                                                                                                                                                                                                                                                                                                               |
| `openui` `stories/flowchart.stories.tsx` (new)                                                                                                             | `ConversationFence` with a no-op services stub written in the story file and the `layout` prop: streaming outline, the concept's [`deploy-map`](../features/openui-diagrams.md#an-example), nesting 4 deep, the 100-node limit with the layout chunk imported directly; a failed layout with a rejecting `layout`; a static fence with `latest: false` |
| `openui` `tests/client/support/random-graph.ts` (new)                                                                                                      | the random-graph generator (Test plan)                                                                                                                                                                                                                                                                                                                 |
| `openui` `tests/client/support/fence.ts`                                                                                                                   | `FenceProps` gains the optional `layout`, passed to `ConversationFence` (F4)                                                                                                                                                                                                                                                                           |
| `openui` `tests/client/skill-text.test.ts`, `tests/client-split.test.ts`, `tests/client-chunk.test.ts`                                                     | FT14, FT9, FT8                                                                                                                                                                                                                                                                                                                                         |
| `openui` `tests/client/layout.test.ts`, `layout-fixtures.test.ts`, `layout-loader.test.ts` (all new)                                                       | FT3–FT7, FT10                                                                                                                                                                                                                                                                                                                                          |
| `openui` `tests/client/diagram-model.test.ts`, `diagram-check.test.ts`, `flowchart.test.ts`, `diagram-colors.test.ts`, `diagram-drawing.test.ts` (all new) | FT11–FT13, FT15–FT17                                                                                                                                                                                                                                                                                                                                   |

No change to `src/contracts/`, `project.json` (chunks are found by directory), `tsconfig*.json` (`src/client/**` is already included), `packages/bundle` or `src/host/validation.ts`.

## Test plan

Tests follow `.agents/skills/behavioral-testing/SKILL.md`. `openui` client tests run in happy-dom (`tests/client/support/dom.ts`); rendering tests mount the real `ConversationFence` through `tests/client/support/fence.ts`.

**The random-graph generator.** `tests/client/support/random-graph.ts` is the generator of the concept's [Measurement method](../features/openui-diagrams.md#measurement-method), which M4 used, written as a test helper (M2 used a variant, described there). It exports:

```ts
export interface Fixture {
  readonly nodes: number;
  readonly edges: number;
  readonly groups: number;
  /** Maximum group depth; ignored when `groups` is 0. */
  readonly depth: number;
}
/** A Flowchart's props as lang-core passes them (F2): `{ nodes, edges, groups }` of element nodes. */
export const randomFlowchart: (fixture: Fixture, seed: number) => unknown;
/** The same graph as an `openui-lang` program in F10's form, for the stories and A2. */
export const randomFlowchartProgram: (fixture: Fixture, seed: number) => string;
```

Its random numbers are Park–Miller's: the state starts at `seed`, and each draw sets `state = state * 16807 % 2147483647` and returns `state / 2147483647`. In this order:

1. Groups `i = 0 … groups − 1`, id `g<i>`, label `Region <i> services`: when `i > 0` and a draw is below 0.5, the candidates are the earlier groups of depth below `depth`; if there are any, the parent is candidate `floor(draw × count)`.
2. Nodes `i = 0 … nodes − 1`, id `n<i>`, label `Service <i>`: when `groups > 0` and a draw is below 0.85, the node's group is group `floor(draw × groups)`.
3. Edges, until `edges` exist or after 100,000 attempts: `a = floor(draw × nodes)`; if node `a` has a group and a draw is below 0.6, `b` is the node `floor(draw × count)` among the nodes of that group, else `b = floor(draw × nodes)`. A pair with `a = b` or already drawn is skipped. An accepted edge is labelled `calls` when a draw is below 0.3.

Groups that end up holding no node are removed by `readFlowchart` (F2 step 4); M4 removed only top-level ones, so FT4's graphs can differ from M4's by such groups. The fixtures are generated in the tests, not committed.

**Program P.** FT13 and FT15 use this program:

```text
root = Stack([chart])
chart = Flowchart(nodes, edges, groups, "down")
nodes = [Node("web", "Web app", "round"), Node("api", "API", "box", "core"), Node("auth", "Auth", "box", "core"), Node("db", "Orders DB", "cylinder", "data"), Node("ok", "Healthy?", "diamond")]
groups = [Group("platform", "Platform"), Group("core", "Core services", "platform"), Group("data", "Data", "platform")]
edges = [Edge("web", "api", "HTTPS"), Edge("api", "auth"), Edge("api", "db", "SQL", "dashed"), Edge("api", "ok", "", "solid", "none")]
```

### Step 1

- **FT1** (`packages/desktop/tests/viewport.test.ts`): the tests of `bundles/features/papercraft/tests/client/viewport.test.ts:22-100`, of which only the import path changes, to `../src/viewport.js`; and `wheelGesture`: not zoom and not captured gives `undefined`; zoom with `deltaY` −40 gives factor 1.1 and +40 gives 1/1.1, whether captured or not; a captured pan with `deltaMode` 0, 1 and 2 scales the deltas by 1, 16 and `pageHeight`; `pageHeight` 0 with mode 2 scales by 800.
- **FT2** (papercraft): `tests/client/viewport.test.ts` keeps the grid test; `tests/client/canvas-element.test.ts:1805` ("the wheel over the program pans the focused node and zooms with the modifier") passes unchanged.

### Step 2

- **FT3** (`tests/client/layout.test.ts`, the real chunk module): for a graph with one group holding two nodes, one top-level node and three edges, one labelled, one a self-loop: every key of the graph is in the result; each edge has at least 2 points with no two equal in a row; each non-loop edge's first point lies on its source box's border and its last on its target's (within 0.5 px); the labelled edge has a label box; the group box contains its nodes' boxes.
- **FT4** (`tests/client/layout-fixtures.test.ts`, G3 a): for every seed of the fixtures 20/28/4/2, 50/70/none, 50/70/10/3 and 100/200/25/4, in both directions, `randomFlowchart` read by `readFlowchart`, sized by F5 under the estimate and laid out: no two node boxes intersect; no edge segment intersects a node box other than its ends, shrunk by 2 px; no node box intersects a group that does not contain it; no two groups intersect unless one contains the other; no edge label box intersects a node box. Time is not asserted.
- **FT5** (`tests/client/layout-fixtures.test.ts`): every group is at least its `minWidth` wide, in both directions.
- **FT6** (`tests/client/layout-fixtures.test.ts`, [A4](../features/openui-diagrams.md#riskiest-assumptions), "same program, same picture", tested in Node): each fixture laid out twice gives deep-equal results.
- **FT7** (`tests/client/layout.test.ts`): a graph with a repeated key, an edge to a missing node and a node in a missing group each reject with `Invalid layout graph:`.
- **FT8** (`tests/client-chunk.test.ts`, the built `dist`): `client/chunks/layout.js` contains `org.eclipse.elk.layered`, the source statement of F11 and both ELK notices (`Copyright (c) 2017 Kiel University and others.`, `Copyright (c) 2021 Kiel University and others.`); it contains neither `new Function(` nor `eval(`, and no `import` statement; `client/chunks/renderer.js` does not contain `org.eclipse.elk` and contains `./layout.js`.
- **FT9** (`tests/client-split.test.ts`): `src/client/chunks/layout.ts` reaches no relative module by value; the entry and the renderer chunk still share only `chat-contract.ts` (`:113-122`).
- **FT10** (`tests/client/layout-loader.test.ts`, a fake module): `load` is not called before the first layout and is called once for three layouts; a rejected `load` makes that layout and every later one reject with its error, and `load` is not called again.
- **FT11** (`tests/client/diagram-model.test.ts`): `readFlowchart` on element-node props, one case per F2 rule, asserting the drawn parts and the exact finding texts in order: an id of 0 and of 65 characters; a repeated node and group id; a 30-character id written in a finding as its first 23 characters and `…` inside the quotes, and an id with a `"` escaped after shortening; `cut` set only for a type a limit cut, and an edge dropped for a missing end not counted in it; 101 nodes, 201 edges, 26 groups; an unknown parent; a two-group loop; a group naming itself as parent (a loop); a child written before its parent (kept); five nested groups (the fifth at the top level); a chain of six (the fifth at the top level, the sixth at depth 2, one finding); a node in an unknown group; a group with no node and its empty child; an edge to an unknown node; a 121-character label (cut to 119 and `…`); a label of 61 emoji (122 UTF-16 code units, 61 characters; not cut); a label of 121 emoji (cut without splitting a surrogate pair); an empty label; no nodes; a self-loop and a repeated edge (drawn, no finding); `shape: "hexagon"` (box, no finding); a non-element entry (skipped, no finding); `edges: null` (no edges, no finding).

### Step 3

- **FT12** (`tests/client/diagram-check.test.ts`, through `programCheck` and `check`): the F3 example gives exactly its line; two `Flowchart`s inline in `root` give one line for `root`; a `Node` in a `Stack` gives `Node draws only inside a Flowchart.` on its statement; a statement with `@OpenUrl` and a diagram finding gives one `runtime-error` holding both texts; a valid diagram gives no line; a 20-finding diagram gives one message of at most 300 code units that holds findings 1 to `20 − K` and ends with ` <K> more not shown.`; an edge whose three ids are 24 control characters each gives `Diagram problems (1): 1 more not shown.`; a statement with `@OpenUrl` and an `AskForm` off the root and a diagram finding merges into the `@OpenUrl` error; through `check`, a question fence in an agent Thread whose `root` holds an inline `Flowchart` with a finding gives one `root` line holding the refusal and the diagram message
- **FT13** (`tests/client/flowchart.test.ts`, `ConversationFence`, G4): a `streaming` fence whose body is program P cut after `Edge("api", "au` shows the outline header `Flowchart: 5 nodes, 1 connection, 3 groups`, the lists, the streaming note, no `svg` and no error card; the edge to `"au"` is not listed. The body then grows by its next chunk inside one synchronous `act` with no timer advanced, and the new connection is in the outline when `act` returns. A 101-node `Flowchart` shows `100 of 101 nodes`. A `closed` fence of program P shows the outline header and no error card. `FlowchartView` under a bare `Renderer`, with no fence context, shows the outline and its note.

### Step 4

- **FT14** (`tests/client/skill-text.test.ts`): `defineDiagramBuiltins` calls `define` with `Node`, `Edge`, `Group`, `Flowchart` in that order; the generated text equals `src/host/skills/openui.md`; the rules are OpenUI's 15 then the 14 Doric rules, in order (the counts at `:117-118` become 15 and 14); the text minus the text generated without the diagram components and rules is at most 4,000 characters (G6).
- **FT15** (`tests/client/flowchart.test.ts`): program P in the `closed`, latest fence of a main Thread, after the layout settles: an `svg[role="img"]` labelled `Flowchart: 5 nodes, 4 connections, 3 groups`, 5 node shapes, 4 edge paths, 3 groups, the outline in an `.sr-only` element the SVG's `aria-describedby` names, the toolbar's buttons, a focusable area. "Zoom in" multiplies the scale by `ZOOM_STEP`; a wheel event without focus is not `defaultPrevented` and leaves the transform; after a `pointerdown` the same event is prevented and pans; a wheel with `ctrlKey` zooms without focus; Escape blurs the area. Program P in an agent Thread, in an older revision and in an `unterminated` fence (UD8): no toolbar, no `tabindex`, and a wheel event with `ctrlKey` is not prevented; when a newer revision arrives, the interactive one loses its toolbar and returns to the fit. Every case passes a fake `layout` prop. A `layout` that rejects with `boom` shows the outline and `This diagram could not be drawn: boom` and adds no line beyond the program check. A layout that settles after the fence unmounted changes nothing. Program P with a button whose action sends (D20): while the send is pending, the wrapper is `inert`, the toolbar stays, the transform stays as panned, and no refit happens.
- **FT16** (`tests/client/diagram-colors.test.ts`, G3 a): with `resolvedVariables(tokens, variant)` for `light` and `dark`, every color role resolves to a hex token or an sRGB mix of two; node, edge and group text are ≥ 4.5 : 1 on every fill they sit on; node strokes and edges are ≥ 3 : 1 on the background and on every group fill. A token that stops being hex fails the test.
- **FT17** (`tests/client/diagram-drawing.test.ts`, a fixed `LayoutResult`): wrapping breaks on spaces and inside a word wider than the line; a label that fits on one line in a `box` takes at least two lines in a `diamond`; each shape's box contains its padded label (the diamond and the circle as the smallest that do); a `round` node's corner radius is half its height; `geometry.ts` ends a vertical segment entering a diamond on its outline and one entering a circle on its circle; a dashed edge is dashed and an `arrow: "none"` edge has no arrowhead; the area's height follows F7 with and without `height`.

### Acceptance

Run by the implementer and the user before phase 1 ships; none is an automated test. The user accepted the 8 prompts and the 2 patch prompts below on 2026-11-06.

- **A2 Main thread and CSP** ([concept A2](../features/openui-diagrams.md#riskiest-assumptions)). A packaged build, a conversation window, one main Thread. The agent is asked to repeat 10 fences verbatim: `randomFlowchartProgram` for the fixtures 50/70/10/3 and 100/200/25/4, seeds 1–5 each. Function names are not minified in the build (`parts.ts:233-238`), so a DevTools Performance profile shows the layout chunk's load and evaluation and each call of its `layout`.
  - _Per diagram._ One profile while the fences arrive. For each fixture, the median over its 5 seeds of the time in `layout`; for the 50/70/10/3 fences, the time from the fence's close to its drawn `svg` (G4, ≤ 500 ms; ≤ 1 s for the window's first diagram).
  - _Thread shown again._ A second profile: show another Thread, then this one. The time from showing it to the last diagram drawn, and the longest main-thread task.
  - _Console._ Any CSP violation.
  - _Exit._ A median above 300 ms (the concept's), a main-thread task above 300 ms in the second profile, or any violation: the limits are lowered, or layout moves off the main thread, with a queue that skips unmounted diagrams if the second profile asks for it; decided with the user ([If A2 fails](#phases)).
- **G1, G2, G3 (b), A1, A6.** The agent answers these 8 prompts, 3 runs each, in a main Thread, without other instruction:
  1. "How does a pull request get from opening to merge in a GitHub flow with CI and review? Show it as a diagram."
  2. "Draw the login flow with password, two-factor authentication and a lockout after five failures."
  3. "Show our deploy pipeline as a diagram: build, test, staging, approval, production and rollback."
  4. "Diagram the states of an order: created, paid, shipped, delivered, cancelled and refunded."
  5. "Show the architecture of a web app on AWS: CDN, load balancer, app servers in a VPC, Postgres, Redis and S3."
  6. "Draw a microservices architecture for an online shop: gateway, auth, catalog, orders, payments, a message queue and their databases, grouped by domain."
  7. "Show a Kubernetes cluster with two namespaces, an ingress, services and pods, and an external database."
  8. "Draw an event-driven data pipeline: producers, Kafka, stream processors, a warehouse and dashboards, grouped by stage."

  G1 counts fences with a `Flowchart` (and a `Group` for 5–8); G2 counts closed revisions with an empty error card; the user judges G3 (b) on the drawn diagrams. A6 ([concept A6](../features/openui-diagrams.md#riskiest-assumptions)): the user tries the gestures on five of them; it passes when the user pans and zooms each of the five without being told how; otherwise the concept's exit applies, zoom and fit buttons only and no wheel gestures, decided with the user. A1 ([concept A1](../features/openui-diagrams.md#riskiest-assumptions)): the same prompts asking for a Mermaid `flowchart`, checked with Mermaid's parser outside Doric; if native G2 trails Mermaid's validity by more than 10 points, UD6 goes back to the user before phase 2.

- **Patches (G2, FR10).** In the same Thread as each run of prompts 3 and 6, a follow-up: after 3, "Add a security scan between test and staging, and make the rollback dashed."; after 6, "Add a recommendations service in its own domain that reads from catalog and orders." That gives 6 patch revisions. G2 counts those whose closed revision has an empty error card. The outline text of the earlier and the patched revision is compared: every node and edge the prompt does not change is still drawn, with the same label. Any part dropped or altered without being asked for goes to the user with P4's per-part form as the alternative (FR10).
- **G5 size.** `npx nx build bundle-openui` before step 1 and after step 4; the growth of `dist/client/chunks/renderer.js` in raw bytes, target ≤ 100 KB (today 5,594,179 bytes); and the size of `dist/client/chunks/layout.js`.

## Measurements

All on 2026-11-06 in a throwaway folder outside the repository, Node 22 on Linux aarch64; the scripts are not kept, and each entry says how to repeat it. FT4–FT6 repeat M4's checks in the repository.

- **M1 What the component receives.** A library of `Stack`, `Flowchart`, `Node` and `Edge` (zod 4.4.3, react-lang 1.0.2's `defineComponent` and `createLibrary`), rendered with `Renderer` through `react-dom/server`'s `renderToString`, recording the props `Flowchart` received; and `createParser(…).parse` of the same text for `meta`. Programs: complete (with a `Node(… "hexagon")` and a `Node("c")` without label), cut inside the `nodes` line, cut inside the `edges` line, and ending before `edges =`. Findings: parts arrive as `{ type: 'element', typeName, props, partial, hasDynamicProps }`; a part missing a required prop is dropped and reported (`missing-required`); at close an invalid optional value is dropped and reported (`type-mismatch`), while streaming it is passed through; `partial` is `true` on every element when the input ends inside a line and `false` otherwise; with `edges` required, the `Flowchart` received nothing in both cut programs and in the one ending before `edges =` (`null-required`), and with `edges` optional it received `edges: null` in those cases.
- **M2 Tokens of P4's two forms.** A variant of the generator, with the same Park–Miller draws and seeds 7919 × 1…5, for 5/4/3, 20/28/4, 50/70/10 and 100/200/25 nodes/edges/groups: ids and labels from a word list, a random shape per node, a group's parent any earlier group with probability 0.5 (no depth bound), each edge between two random nodes, 30 % of edges labelled; both forms written by one script; token counts with `gpt-tokenizer`'s `o200k_base` and `cl100k_base`, means over the 5 seeds; the patch adds one edge from the first node to the last.
- **M3 Skill growth and signatures.** `openuiLibrary.extend({ components: { add: [Flowchart, Node, Edge, Group] } }).prompt(…)` with `openuiPromptOptions`, `inlineMode`, `editMode` and `openuiAdditionalRules`, against the same call without them; then with F10's four rules, as written in F10: +637 and +995 characters.
- **M4 ELK.** elkjs 0.11.1 and 0.12.1, each installed alone; the fixtures 20/28/4/2, 50/70/none, 50/70/10/3 and 100/200/25/4 of the generator (Test plan), seeds 1–5, labels sized at 7.2 px per character, F6's options; checks as in FT4 and FT5; each layout run twice and compared without `$H`; times after one warm-up. Slowest layout with 0.11.1, `DOWN` / `RIGHT`: 52 / 43 ms at 20/28/4/2, 49 / 50 ms at 50/70/none, 66 / 72 ms at 50/70/10/3, 217 / 211 ms at 100/200/25/4; with 0.12.1, 232 ms at the limits. Also, with both versions: one group with a 260 px minimum under `DOWN` and `RIGHT` with both orders of the pair; a self-loop and two parallel edges in a group; `import ELK from 'elkjs/lib/elk.bundled.js'` under Node ESM; and `tsc` (`module: nodenext`, `skipLibCheck`) on F6's cast (no error; `new` on the plain default import is error TS2351, checked with 0.12.1).
- **M5 Parser placement and names.** With the conversation library's react-ui base plus the four components: `root = Flowchart([Node("a", "A")])`, a `Flowchart` inside a `Card` and a `Node` in a `Stack` parse with no `meta.errors`; none of the four names is among react-ui's 82 components.
- **M6 The chunk's comments.** esbuild from the repository (`--bundle --format=esm --platform=browser`, `minifySyntax`, `NODE_ENV` defined, as `parts.ts:233-238`) on an entry with a `/*!` comment that imports `elk.bundled.js`: 2,609,437 bytes with 0.11.1 and 2,669,154 with 0.12.1; `Kiel University` absent; the `/*!` comment present as the file's last line; no `new Function(` and no `eval(`.

## Alternatives considered

- **`edges` required, as the concept's table wrote it.** Rejected: the `Flowchart` leaves the render until `edges` starts (M1), so the outline could not grow while nodes and groups stream.
- **One statement per part** (P4's alternative). Rejected by M2: 28–35 % more tokens to write, recovered only after 3–6 one-edge patches.
- **The definitions in `src/contracts`, beside the question built-ins.** Rejected: the question built-ins live there because their schemas are those of the host contract `openui.questions/v1` (`src/contracts/builtins.ts:8-12`); diagram schemas have no host contract and no second consumer, and the contracts barrel is loaded in every window and by papercraft (F1).
- **A separate `DiagramContext`.** Rejected: `FenceContext` already carries the fence's view around `Renderer` (F4); two fields cover the rest.
- **A layout cache, or a queue that skips the layouts of unmounted diagrams.** Not built in phase 1: a model lays out once per mount, fences remount only when a window opens or a Thread is shown again (F4), and the bundled ELK never runs two layouts at once (F6). FR6's cost of a Thread shown again is measured only in Node; a queue is one of A2's exits, beside the worker.
- **Laying out a diagram only when it scrolls into view.** Rejected: the picture replaces the outline at a different height, and the conversation deliberately lays out every block, even off-screen, so that no block changes height as it scrolls into view (`bundles/desktop/chat/src/client/styles.css:184-189`); its scroll keeping applies after transcript updates and not to a block's own resize (`overflow-anchor: none`, `styles.css:106-110`; `bundles/desktop/chat/src/client/components/organisms/conversation/plugins/scroll-position.ts` observes no resize). A layout started on scrolling would move the transcript under the reader.
- **elkjs 0.12.1, the version the concept measured.** Rejected: on F11's list, zero defects, the same group minimum size, the same self-loop and parallel-edge results and the same default export, 0.11.1 matched it, with a slowest layout of 217 ms against 232 ms and a smaller chunk (M4, M6); 0.11.1 is already the repository's copy, and 0.12.1 would add a second one to the lockfile.
- **`partial` to decide which parts the outline lists.** Rejected: it marks every element of a parse that ends inside a line (M1), so the outline would stay empty while the agent writes.
- **`useIsStreaming` for the streaming state.** Rejected: it is the renderer's `blocked`, which also covers bundle loading (`react-lang/dist/index.mjs:583`); the fence state is what P9 means.
- **ELK node labels for group labels** (`nodeSize.constraints: NODE_LABELS`). Rejected: a group with one 60 px node and a 236 px label grew to 325 × 482 px (M4).
- **Group labels cut to the group's width.** Rejected: a one-node group is 84 px wide (M4), so most labels would be cut; the minimum width (F6) with FT5 makes cutting unnecessary.
- **`performance.measure` marks around each layout.** Rejected: A2 runs once, and a Performance profile of the packaged build gives the same times without shipping instrumentation.
- **The layout loader in a module under `src/client/diagram/`.** Rejected: its `import(new URL('./layout.js', import.meta.url))` would resolve against that module's location, which differs between the bundle and the tests (F6).
- **One error per finding.** Rejected: the card and the host keep one line per code and statement (F3), so all but one would be dropped.
- **A new error code for diagram findings.** Rejected: it would change `OPENUI_ERROR_CODES` (`src/contracts/errors.ts:13-29`, kept equal to lang-core's by `tests/error-codes.test.ts`) and `FIXED_TEXT`; `runtime-error` with a message is what the check already uses (`check.ts:72-77`).
- **License texts in this spec** (version 3 put the EPL-2.0 and Apache License 2.0 texts in the layout chunk's legal comment). Replaced by the user's decision: third-party license texts ship for every bundle from a separate `packages/bundle` change (F11).
- **Moving `fit.ts` or `useCanvasGestures` to `packages/desktop`.** Not chosen, as in the concept (P13): both are tied to papercraft's frame and tools.
- **Changing each of papercraft's twelve viewport importers.** Not chosen: a re-export from its `viewport.ts` keeps those files unchanged (F9).

## Risks

- **FR1 ELK's direction-relative minimum size.** A later elkjs could apply `nodeSize.minimum` in the absolute frame, making `down` groups too tall and too narrow. Mitigation: the exact pin (F11); FT5 fails on any change.
- **FR2 The notice is lost.** A bundler change could drop `/*!` comments. Mitigation: FT8 on the built chunk.
- **FR3 Transient outline entries.** While a string is still being written, an edge whose `to` is a prefix of another id may be listed for one chunk. Mitigation: accepted; the picture is drawn only from the closed program.
- **FR4 Dynamic props.** A part with a `$variable` is drawn but not checked (F2). Mitigation: accepted; the skill's examples use literals only.
- **FR5 Findings left out or hidden.** A statement with many findings, or with another error of the check and diagram findings, reports one line of at most 300 code units (F3), so later findings are named only by their count, or, when the other error leaves too little room, dropped by the reporter's cut. A `runtime-error` OpenUI reports on a statement that also has diagram findings is hidden by the card's and the host's one line per code and statement. Mitigation: the message counts what it leaves out; skill rule 2 gives a `Flowchart` a statement of its own, which no other error of the check names unless the agent puts `@OpenUrl` on it or the `Flowchart` in a question fence's `root`; the agent fixes the first findings and the next revision reports the rest; accepted.
- **FR6 Main thread on a Thread shown.** Opening or showing a Thread mounts every fence in it and lays out every closed `Flowchart` revision (F4); every revision of a patched diagram has its own fence and its own picture. Each layout is one main-thread task: in Node at most 52 ms at 20 nodes, 72 ms at 50 and 217 ms at the limits (M4). In Node, a Thread with ten revisions at the limits would cost about 2.2 s of main-thread time, in tasks of about 220 ms, and a Thread left before its layouts finish still runs them; browser times are not measured. Mitigation: the limits; A2 profiles a Thread with ten large diagrams shown again, and its exits are lower limits, a worker, or a queue that skips unmounted diagrams ([If A2 fails](#phases)).
- **FR7 Static fences cut off.** A large diagram in a static fence fitted at 25 % may still be larger than its area and cannot be panned (UD8). Mitigation: the limits; the latest revision is interactive.
- **FR8 Fonts.** A label measured before its face loads would be drawn wider than its box. Mitigation: measurement first loads the faces the labels' characters need with `document.fonts.load` (F5), which covers subsets no text has requested yet.
- **FR9 Prisma Studio moves.** If `@prisma/studio-core` changes its exact elkjs version, npm keeps a second copy for it; `openui` still resolves its own 0.11.1. Mitigation: none needed.
- **FR10 Patches drop parts.** Inline lists make a patch rewrite a whole list (F10): one new edge at the limits rewrites 200 edges, 1,886 tokens (M2), and the agent may drop or alter edges it was not asked to change. No measurement covers it. Mitigation: the patch prompts of [Acceptance](#acceptance) compare the outlines of both revisions; a dropped or altered part takes P4's per-part form back to the user.
- **FR11 The EPL's source availability.** F11 rests on reading EPL-2.0 §3.1 (a) so that pointing to the two upstream repositories makes the Source Code available; that reading is not proven. Mitigation: accepted by the user, who decided that no legal review is needed (2026-11-06); if the reading is challenged, Doric can publish the elkjs 0.11.1 source beside its own releases.
- **FR12 Releases before the license-files change.** Until the separate `packages/bundle` change lands, a release carries the GWT and Guava code in the layout chunk without the Apache License 2.0 text (F11). Mitigation: accepted by the user, who decided that phase 1 may ship before that change (2026-11-06); the change stays recorded with its requirement to cover the code inside `elk.bundled.js`.
- The concept's R1–R12 apply unchanged ([Risks](../features/openui-diagrams.md#risks)).
- **Security.** Labels and ids are drawn as React text nodes; no prop becomes markup, a URL, a style or an attribute name. Colors come only from `colors.ts`.
- **Scale.** At most 100 nodes, 200 edges and 25 groups per diagram; one layout per diagram revision per mount (FR6).

## Open questions

None. The user accepted the 2 patch prompts (Q1 of version 3) and decided how license texts ship (F11).

Version 1's two questions were answered by the user on 2026-11-06 ([Decisions already made](#decisions-already-made)): Doric does not distribute ELK in a commercial product offering and needs no legal review, and the 8 acceptance prompts are accepted.

## Docs to update

Listed here, not edited by this document, except the concept's Evolution entry, which links this spec. Each is updated when step 4 lands.

- **[docs/features/openui-diagrams.md](../features/openui-diagrams.md)**: status `implemented` for phase 1; "Current behavior and contracts" describes `Flowchart` as built; an Evolution entry for the release, with the commit.
- **[docs/architecture/bundles/implementation-decisions.md](../architecture/bundles/implementation-decisions.md)**: the decision that phase 1 may ship before the license-files change (FR12).
- **[docs/features/papercraft.md](../features/papercraft.md)**: an Evolution entry for the pan and zoom helpers moved to `desktop/ui/viewport`.
- **[docs/features/generative-ui.md](../features/generative-ui.md)**: "Current behavior and contracts" (`:28-35`) names diagrams and their outline; an Evolution entry with manifest 2.2.0.
- **`bundles/features/openui/README.md`**: a "Diagrams" section (the components, the outline, layout at close, pan and zoom, static fences); "Entry and renderer chunk" (`:88-110`) gains the layout chunk and its loader; "Dependencies" (`:112-118`) gains `elkjs` 0.11.1 under the EPL-2.0, notes the GWT runtime and Guava code it holds under the Apache License 2.0, and names F11's legal comment and the license files of the separate `packages/bundle` change.
- **[GROUNDING.md](../../GROUNDING.md)** (AGENTS.md asks for it on a dependency change): the `openui` paragraph (`:998-1022`): version 2.2.0 (it reads 2.0.0 today), the diagram components and the layout chunk with elkjs; the sentence on `packages/desktop/ui` (`:882`) lists the viewport helpers among its generic primitives.
- **`bundles/features/papercraft/README.md`**: the canvas's pan and zoom math comes from `desktop/ui/viewport`.

## Revisions

- **Implementation notes (2026-11-06), no version change.** Contract adjustments made while writing the contracts: F6's `LayoutGraph` carries `groupPadding: { top, side }`, filled by `graph.ts` from `DIAGRAM_METRICS`, so the chunk needs no value import of `measure.ts`; F5 lists `DIAGRAM_METRICS` among `measure.ts`'s exports; F3 passes `parsed?.root` to `diagramCheck`.
- **Version 5 (2026-11-06).** Answers the Readiness and Codebase reviews and records the user's decision that phase 1 may ship before the `packages/bundle` license-files change, which stays a recorded follow-up (F11, Phases, FR12 an accepted risk). Phases: `definitions.ts`, `model.ts` and FT11 move to step 2; step 3 says a closed `Flowchart` shows its outline; the layout effect, the context's fields and the loader land in step 4. F4: `ConversationFence` takes an optional `layout` prop, the seam for tests and stories. F2: `written` becomes `cut`, set only per type a limit cut; the finding texts fix shortening before JSON escaping and the order of the parent rules. F3: `mergeDiagramErrors` runs over `check`'s whole list, `questionCheck` included, into the first error of the statement; a message with no finding that fits; OpenUI's hidden `runtime-error` in FR5. F5, F6, F7: interfaces of `measure.ts` (`Sizes`, `TextBlock`), `graph.ts`, `canvas.tsx`, `outline.tsx`, `geometry.ts` and `colors.ts`; the diagram font is `--font-conversation` (IBM Plex Mono); one `ELK` instance per window; the layout graph's parents in any order. Terms and F8: interactive across one mount and while a click is sending. F9: the shared type is `WheelGestureInput`, papercraft keeps its `WheelInput`; the pan's sign. F10: `groups = []` in rule 2, G6 re-measured at 1,632. F12: rollback. Line references corrected.
- **Version 4 (2026-11-06).** Answers the second Scope review and records the user's decisions: third-party license texts ship for every bundle from a separate `packages/bundle` change, outside this spec, and phase 1 ships after it (F11, Phases, FR12); the 2 patch prompts are accepted. F11: the legal comment is back to ELK's notices and the source statement; the EPL-2.0 and Apache License 2.0 texts and their FT8 checks are removed. F6: version 2's loader is back (load once, no queue, no signal); a queue that skips unmounted diagrams is one of A2's exits, beside lower limits and a worker. F4: one failed state for a failed layout and a chunk that did not load, as the entry shows its renderer chunk; no error class or console line. F3: the merge appends after `; ` with no threshold rule; FT12's unreachable case removed. Phases: "If A2 fails" reduced to the two exits and what stays.
- **Version 3 (2026-11-06).** Answers the Critique, Style, Comprehension and Structural reviews. Terms move before Goals and define box, character (a code point, in every limit and text), error card, fixture `n/e/g/d`, interactive with all four of `blockedReason`'s conditions, and latest revision; an identifier key joins the header. F2: findings are single sentences with `<x>` placeholders. F3: numbered findings in a message built to fit 300 code units, with a count of those left out. F4: the fence context's `layout` takes an `AbortSignal`; a chunk that did not load has its own note; remounts cite `FenceElements`. F5: `document.fonts.load` for the labels' characters. F6: the loader queues layouts one at a time and drops aborted ones, logs a failed load once, and is one per window. F7: shapes stated; no group `title`. F11: the legal comment carries the EPL-2.0 and Apache License 2.0 texts, for the GWT and Guava code in `elk.bundled.js`; the EPL reading is FR11, an accepted risk. Phases: F5's measuring in step 2; the rework if A2 fails. Test plan: the random-graph generator as a test helper, program P, FT10–FT13, FT15 and FT17 extended. Acceptance: A2 profiles a Thread shown again, A6's pass condition, two patch prompts (Q1), G5's build command. Risks: FR6 restated; FR10–FR12 added. G6 re-measured with the rules as written: 1,596.
- **Version 2 (2026-11-06).** Answers the Scope review and records the user's answers (no commercial distribution of ELK and no legal review; the 8 acceptance prompts accepted; no spike). F1: the definitions move from `src/contracts` to `src/client/diagram/definitions.ts`; the contracts module no longer changes. F4: `FenceContext` gains `interactive` and `layout` in place of a separate diagram context. F6: the layout queue becomes a loader that loads once, with no cache and no serialization. Phase 2 constraints removed. F2, F5, F7, F8: constants and drawing details left to code and tests; interfaces, finding texts and limits kept. F11: elkjs 0.11.1, the lockfile's copy, after measuring it against 0.12.1 (M4, M6). F7: no group-label cutting. A2 reads a Performance profile; no `performance.measure` marks. Tests renumbered FT1–FT17; the elkjs version test and FR4 (two copies) removed.
- **Version 1 (2026-11-06).** First version, from the accepted concept (UD1–UD13, P1–P14) and the code search of the same day.
