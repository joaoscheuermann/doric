# Spec: diagrams in OpenUI fences, phase 2 — `SequenceDiagram`, `EntityDiagram`, `MindMap`

- Ticket: none; the work comes from the accepted concept [docs/features/openui-diagrams.md](../features/openui-diagrams.md) (UD13's phase 2).
- Status: `implemented` (code 2026-11-06, uncommitted), acceptance pending; version 5 (2026-11-06) is the accepted design. The user pre-approved implementation after the review stages and accepts both phases manually. G5 is not met by 194 bytes: `dist/client/chunks/renderer.js` measured 5,694,373 bytes on a clean build, 100,194 over 5,594,179 against a 100,000-byte target. Phase 2's growth, 58,600 bytes over phase 1's 5,635,773, passed FR17's stop threshold of 58,406 by 194 bytes; the coordinator did not stop, because the overrun is 0.2 % of an unminified chunk, G5 is an acceptance target and the user accepts both phases manually. The size is an acceptance item for the user (FR17).
- Scope: phase 2 of [UD13](../features/openui-diagrams.md#decisions): `SequenceDiagram` with `Participant`, `Message`, `Note`, `Fragment` and `Section` (UD9); `EntityDiagram` with `Entity`, `Field` and `Relation`, for ER and class diagrams, methods as plain strings (UD10); `MindMap` with recursive `Topic`; no icons (UD11); UD12's limits. It also settles what phase 1 left to phase 2: how the new types join the reading, the check, the outline and the layout ([phase 1 spec](openui-diagrams.md), Scope).
- Why a separate document: the [phase 1 spec](openui-diagrams.md) is `accepted` at version 5 and implemented; it describes one change and stays as it is. The repository keeps one spec per large change (`docs/designs/`), so phase 2 has its own and links phase 1's for the decisions it keeps.
- Builds on: phase 1 as built on 2026-11-06, uncommitted, all tests green (openui 241/241, desktop 192/192, papercraft 321/321). Line references to phase 1's files name the working tree as built; references to other files are checked against commit `fc76b9fa`. `openui` paths are under `bundles/features/openui/` unless written in full.
- Identifiers continue phase 1's, so both documents can be cited together: F13–F24 are this spec's design decisions, FT18–FT37 its tests, FR13–FR24 its risks, M7–M13 its measurements. G (goals), UD (decisions), P (proposals), A (riskiest assumptions) and R (risks) are the concept's ([docs/features/openui-diagrams.md](../features/openui-diagrams.md)); F1–F12, FT1–FT17, FR1–FR12 and M1–M6 are phase 1's ([phase 1 spec](openui-diagrams.md)); U48 is a decision of the [OpenUI spec](openui.md#decisions-already-made).
- Bundles touched: `openui` only. Its version stays 2.2.0 (F24). `packages/desktop` and `papercraft` do not change.
- Feature docs: [docs/features/openui-diagrams.md](../features/openui-diagrams.md) (the concept, status `implemented` for both phases) and [docs/features/generative-ui.md](../features/generative-ui.md).
- Measurements: [Measurements](#measurements) says where and how each was made.

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

Phase 1 draws one diagram type. The conversation library adds `Flowchart`, `Node`, `Edge` and `Group` only (`src/client/library.ts:29-35,70-75`), so a sequence, an ER or class diagram, or a mind map has no native form. Phase 1's code is written for that one type: the reading returns a `FlowchartModel` and its finding texts name the Flowchart (`src/client/diagram/model.ts:101-130,223`); the check knows one diagram and its three parts (`src/client/diagram/check.ts:11,73-88`); the outline, the drawing and the view take a `FlowchartModel` (`outline.tsx:19-27,57-63`, `canvas.tsx:355-362`, `flowchart.tsx:66-127`); the layout chunk runs `layered` only (`src/client/chunks/layout.ts:122-130`). The concept chooses an engine per type (P8): ELK `layered` for entity diagrams, as for flowcharts, ELK `mrtree` for mind maps, and Doric's own layout for sequences, which never loads the layout chunk ([Per type (P8)](../features/openui-diagrams.md#per-type-p8)).

## Terms

Phase 1's terms apply ([Terms](openui-diagrams.md#terms)): box, character, drawn part, error card, finding, fixture, fit, interactive, latest revision, layout chunk, layout graph, layout result, layout loader. So do the concept's ([Terms](../features/openui-diagrams.md#terms)): diagram component, part, id, outline, diagram model, entry, renderer chunk, skill, closed union, slot, ELK, elkjs, layered, mrtree, orthogonal routing, random seed; the papercraft concept's ([papercraft.md, Terms](../features/papercraft.md#terms)): program, statement, statement name, library, patch; and the OpenUI spec's ([openui.md, Terms](openui.md#terms)): fence, revision. This document adds:

- **lang-core, react-ui**: OpenUI's packages `@openuidev/lang-core` 1.0.2, which parses programs and defines components, and `@openuidev/react-ui` 0.18.1, the component library the conversation extends (`package.json:16-18`). `Stack` is react-ui's vertical container.
- **prompt builder**: lang-core's `library.prompt(…)`, which prints each component's signature and description into the skill (`tests/client/skill-text.test.ts:76-110`).
- **statementId**: the statement name an element was written in (`top`, `b1`), which lang-core puts on the element; the check attributes findings by it (`ReportedError.statementId`, `docs/designs/openui.md:578`).
- **null-required, type-mismatch, unresolved**: lang-core's parse results for a required prop that is still missing, a prop of the wrong type, and a reference to a statement not written yet (`meta.unresolved`).

- **step**: an entry of a `SequenceDiagram`'s `steps` or of a `Section`'s `steps`: a `Message`, a `Note` or a `Fragment`. Steps are counted depth-first in program order; a `Fragment` counts as one step and its sections' steps count too; a `Section` is not a step. The Phases' steps 5–9 are a different thing: phase 1's numbering of implementation steps.
- **row**: the vertical band one step takes in a drawn sequence diagram; a fragment's row holds its sections' rows.
- **topic path**: how a finding names a topic, which has no id: the labels from the root to it joined by `›`, each shortened as ids are (F14).
- **end label**: a label ELK places at one end of an edge (`TAIL` at its source, `HEAD` at its target). Phase 2 uses end labels for a class diagram's counts.
- **transposed layout**: a `right` layout made by laying out the graph with every width and height swapped in the `down` direction, then swapping x with y and width with height in the result (F18).
- **notation**: an `EntityDiagram`'s `er` (default) or `class`.
- **entity fixture `e/r`, mind-map fixture `t/d`, sequence fixture `p/s`**: programs of the random generators ([Test plan](#test-plan)): `e` entities and `r` relations; `t` topics nested at most `d` levels; `p` participants and `s` steps. Each exists for the seeds 7919 × 1…5, as phase 1's fixtures do.
- **estimate**: phase 1's measure without a canvas: 7.8 px per character (`DIAGRAM_METRICS.estimate`, `measure.ts:52,72-73`). Tests and measurements size text with it.
- **marker**: the shape drawn at a relation's end (a crow's foot, a triangle, a diamond, an arrowhead; F20).

## Goals

The concept's goals ([Goals and success measures](../features/openui-diagrams.md#goals-and-success-measures)) as they apply to phase 2. Two kinds of check: automated tests, which fail the build in the step that adds them (FT14 for G6; FT23, FT27 and FT29 for G3 (a); FT31 and FT32 for G4 and G5), and [Acceptance](#acceptance) checks, which the user reads before accepting both phases; no acceptance target decides the release alone ([U48](openui.md#decisions-already-made), as in phase 1). The phase 2 prompt set is 12 prompts of [Acceptance](#acceptance), 4 per type, 3 runs each: 36 fences. With phase 1's 24 they make the concept's 60.

| Goal                                  | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 The agent picks the right diagram  | Share of the 36 fences holding the component of the prompt's type; target ≥ 90 %                                                                                                                                                                                                                                                                                                                                                                                                                         |
| G2 Valid when first written           | Share of the 36 fences whose closed revision has no line in the error card; target ≥ 90 %. The 9 patch revisions are counted apart, same target                                                                                                                                                                                                                                                                                                                                                          |
| G3 (a) Readable, automatic            | FT27 and FT23 on every entity and mind-map fixture, both directions: zero box overlaps, edges through a box, edge labels or end labels on a box, label overlaps, end segments shorter than their marker, markers on another entity; touching markers at most M9's counts (FR20); FT29 on every sequence fixture: zero message labels on another label or on a note, every fragment holding its steps, nothing outside the drawing; FT16 for contrast, unchanged because phase 2 adds no color role (F20) |
| G3 (b) Readable, judged               | The user judges the 36 drawn diagrams; target ≥ 80 %                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| G4 Immediate feedback                 | Outline as in phase 1, computed in the render that receives the revision (FT31). Drawn: ≤ 500 ms from close for the entity fixture 30/50, the mind-map fixture 100/5 and the sequence fixture 20/200 once the chunk is loaded, checked by [A2](#acceptance); a sequence diagram never waits for the chunk (FT32)                                                                                                                                                                                         |
| G5 No cost to fences without diagrams | FT8 as in phase 1; a `SequenceDiagram` never calls the layout loader (FT32). Growth of `dist/client/chunks/renderer.js` across both phases ≤ 100,000 bytes; phase 1 added 41,594 bytes (5,594,179 → 5,635,773, the sandbox's build after phase 1's tests), so phase 2 has 58,406 bytes (FR17)                                                                                                                                                                                                            |
| G6 The skill stays small              | FT14 extended: both phases together add at most 4,000 characters; measured as built with F22's rules: 3,847 (M7)                                                                                                                                                                                                                                                                                                                                                                                         |

## Decisions already made

From the concept, binding here: UD1–UD8 and UD11 as in phase 1; **UD9** `Note`, `Fragment` and `Section` are in phase 2; **UD10** methods are plain strings; **UD12** 20 participants and 200 steps per `SequenceDiagram`, 60 entities and 120 relations per `EntityDiagram`, 300 topics and 8 levels per `MindMap`, labels cut at 120 characters; **UD13** phase 2 is this document. P8 (`layered` for entities, `mrtree` for mind maps, own layout for sequences), P9 (outline while streaming, one layout at close), P11–P14 as phase 1 applies them.

From phase 1, kept unchanged: F2's id rules and label cutting, F3's message format and merge, F4's states and fence context, F5's font and measuring, F6's loader and its seam, F7's colors and height bounds, F8–F9's pan and zoom, F11's notice, F12's contracts.

From the user (2026-11-06): the phases are accepted manually at the end, together, in one commit; no approval is asked between steps.

## Non-goals

- Activations (lifeline bars), `create`/`destroy` messages, participant kinds (actor, database) and numbered messages in sequence diagrams; notes beside a participant (`left of`, `right of`).
- Field visibility, static or abstract members, generics, or interfaces drawn differently from classes; association classes; n-ary relations.
- A radial mind map with branches on both sides of the root; colored branches.
- Clicks on parts, export, icons, Mermaid (UD4–UD6, UD11).
- Diagram components inside closed-union containers (slots), as in phase 1.
- A layout queue or worker: they are A2's exits ([concept A2](../features/openui-diagrams.md#riskiest-assumptions): ELK fits a window's main thread), as in phase 1 ([If A2 fails](openui-diagrams.md#phases)).

## Design decisions

| #   | Decision                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F13 | Twelve components, defined from data in `definitions.ts` beside phase 1's four by three new definers; recursion through zod getters; `steps` and `relations` optional, as `edges` is.                                                       |
| F14 | One pure reading per type, built from phase 1's helpers moved into a shared module; each returns its drawn parts, `cut` counts and findings in a fixed order with fixed texts, including a sequence part in the wrong nested list.          |
| F15 | The check walks every diagram type through one table of readings and parts; a part outside its own diagram gets a finding. Messages and merging are phase 1's.                                                                              |
| F16 | The outline becomes generic: a header and labelled lists that may nest; each type provides its own.                                                                                                                                         |
| F17 | Each type's view uses one shared hook for the layout-once-per-mount state machine of phase 1's `FlowchartView`; the states and notes are phase 1's.                                                                                         |
| F18 | The layout graph gains an algorithm (`layered` or `mrtree`), end labels and two flags: entity graphs get spacing for line-end markers, and class graphs are laid out `right` transposed. Entity diagrams use `layered`, mind maps `mrtree`. |
| F19 | Sequence diagrams lay themselves out in a pure function of the renderer chunk: columns in participant order, rows in step order, fragments as boxes around their rows. They never load the layout chunk.                                    |
| F20 | The drawing splits into a shared frame (area, viewport, toolbar, height) and one SVG picture per type; every color is an existing role.                                                                                                     |
| F21 | Measuring adds a sizing function per type over phase 1's `wrapLabel` and font.                                                                                                                                                              |
| F22 | Phase 1's four skill rules are replaced by five rules for all four types; mind maps write one statement per first-level branch.                                                                                                             |
| F23 | Lists stay inline (P4), as measured for phase 1, sequence steps included; only first-level branches become statements, as measured for patches.                                                                                             |
| F24 | `openui` stays at 2.2.0: phase 1 and phase 2 ship in one commit and one release.                                                                                                                                                            |

## Design

### Overview

```text
agent's fence ─▶ ConversationFence ─▶ Renderer ─▶ FlowchartView | SequenceView | EntityView | MindMapView   (F17)
                                                      │ readX(props)                                     (F14)
                                                      ├─ streaming ─▶ Outline(outlineX(model))            (F16)
                                                      └─ closed / unterminated ─▶ useDrawn(key, draw)     (F17)
                                                            ├─ sizes (F21)
                                                            ├─ Flowchart, Entity, MindMap: layout loader ─▶ chunks/layout.js (layered | mrtree) (F18)
                                                            ├─ Sequence: layoutSequence(model, measure), no chunk (F19)
                                                            └─ DiagramFrame + XPicture (F20)
programCheck / check ─▶ diagramCheck(root): DIAGRAMS table ─▶ readX ─▶ mergeDiagramErrors                    (F15)
```

### F13. The components

**Definitions.** `src/client/diagram/definitions.ts` keeps `NODE_SHAPES`, the three flowchart schemas and `defineDiagramBuiltins` unchanged and `FLOWCHART_LIMITS` with the same keys and values (`definitions.ts:10-108`; its `label` and `id` now read `TEXT_LIMITS`, below), and adds:

```ts
export const SEQUENCE_LIMITS = {
  participants: 20,
  /** Messages, notes and fragments, depth-first (Terms, step). */
  steps: 200,
} as const;
export const ENTITY_LIMITS = {
  entities: 60,
  relations: 120,
} as const;
export const MINDMAP_LIMITS = {
  topics: 300,
  /** Levels; the root Topic is level 1. */
  depth: 8,
} as const;

export const MESSAGE_KINDS = ['call', 'reply', 'async'] as const;
export const FRAGMENT_KINDS = ['loop', 'opt', 'alt', 'par'] as const;
export const FIELD_KEYS = ['pk', 'fk', 'pk-fk', 'unique'] as const;
export const RELATION_KINDS = [
  'association',
  'inherits',
  'implements',
  'composition',
  'aggregation',
  'dependency',
] as const;
export const COUNTS = ['1', '0..1', '*', '1..*'] as const;

/** Participant, Message, Note, Section, Fragment, then SequenceDiagram; returns them in that order. */
export const defineSequenceBuiltins: <
  C,
  D extends { readonly ref: z.core.$ZodType },
>(
  define: DefineComponent<C, D>,
  renderers: {
    readonly Participant: C;
    readonly Message: C;
    readonly Note: C;
    readonly Section: C;
    readonly Fragment: C;
    readonly SequenceDiagram: C;
  },
) => readonly [D, D, D, D, D, D];
/** Field, Entity, Relation, then EntityDiagram. */
export const defineEntityBuiltins: <
  C,
  D extends { readonly ref: z.core.$ZodType },
>(
  define: DefineComponent<C, D>,
  renderers: {
    readonly Field: C;
    readonly Entity: C;
    readonly Relation: C;
    readonly EntityDiagram: C;
  },
) => readonly [D, D, D, D];
/** Topic, then MindMap. */
export const defineMindMapBuiltins: <
  C,
  D extends { readonly ref: z.core.$ZodType },
>(
  define: DefineComponent<C, D>,
  renderers: { readonly Topic: C; readonly MindMap: C },
) => readonly [D, D];
```

**Schemas.** In the order written, all strings unless stated:

| Component         | Props                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Participant`     | `id`, `label`                                                                                                                                                 |
| `Message`         | `from`, `to`, `text`, `kind?` (`MESSAGE_KINDS`)                                                                                                               |
| `Note`            | `text`, `over` (array of strings)                                                                                                                             |
| `Section`         | `label`, `steps` (array of the union of `Message`, `Note` and `Fragment` refs)                                                                                |
| `Fragment`        | `kind` (`FRAGMENT_KINDS`), `sections` (array of `Section` refs)                                                                                               |
| `SequenceDiagram` | `participants` (array of `Participant` refs), `steps?` (as `Section.steps`), `height?` (number)                                                               |
| `Field`           | `name`, `type?`, `key?` (`FIELD_KEYS`)                                                                                                                        |
| `Entity`          | `id`, `name`, `fields?` (array of `Field` refs), `methods?` (array of strings)                                                                                |
| `Relation`        | `from`, `to`, `kind?` (`RELATION_KINDS`), `label?`, `fromCount?` (`COUNTS`), `toCount?` (`COUNTS`)                                                            |
| `EntityDiagram`   | `entities` (array of `Entity` refs), `relations?` (array of `Relation` refs), `notation?` (`er`, `class`), `direction?` (`down`, `right`), `height?` (number) |
| `Topic`           | `label`, `children?` (array of `Topic` refs)                                                                                                                  |
| `MindMap`         | `root` (`Topic` ref), `layout?` (`right`, `down`), `height?` (number)                                                                                         |

**Recursion.** `Section.steps` names `Fragment`, defined after it, and `Topic.children` names `Topic`. Both are zod getters on the object shape, read after the definer has defined both components: `z.object({ label: z.string(), get steps() { return z.array(z.union([message.ref, note.ref, fragment.ref])); } })`. The prompt builder prints them as `(Message | Note | Fragment)[]` and `Topic[]` (M7); `z.lazy` prints `any` (M7) and is not used. TypeScript needs the getter's return type written out where inference is circular; the definer annotates it with `z.ZodArray<…>`.

**Signatures and descriptions.** As the prompt builder prints them (M7):

```text
SequenceDiagram(participants: Participant[], steps?: (Message | Note | Fragment)[], height?: number) — Messages between participants over time, in steps order.
Participant(id: string, label: string) — One lifeline of a SequenceDiagram.
Message(from: string, to: string, text: string, kind?: "call" | "reply" | "async") — One message between two Participant ids; from equal to to is a self-message.
Note(text: string, over: string[]) — A note over one or more Participant ids.
Fragment(kind: "loop" | "opt" | "alt" | "par", sections: Section[]) — A loop, option, alternative or parallel block of steps.
Section(label: string, steps: (Message | Note | Fragment)[]) — One labelled run of steps of a Fragment.
EntityDiagram(entities: Entity[], relations?: Relation[], notation?: "er" | "class", direction?: "down" | "right", height?: number) — ER or class diagram laid out automatically.
Entity(id: string, name: string, fields?: Field[], methods?: string[]) — One table or class; methods for classes only.
Field(name: string, type?: string, key?: "pk" | "fk" | "pk-fk" | "unique") — One column or attribute of an Entity.
Relation(from: string, to: string, kind?: "association" | "inherits" | "implements" | "composition" | "aggregation" | "dependency", label?: string, fromCount?: "1" | "0..1" | "*" | "1..*", toCount?: "1" | "0..1" | "*" | "1..*") — A relation between two Entity ids; kind applies to class diagrams.
MindMap(root: Topic, layout?: "right" | "down", height?: number) — A mind map (right) or a tree (down) from one root Topic.
Topic(label: string, children?: Topic[]) — One topic of a MindMap and its subtopics.
```

The concept's signatures are kept, with three changes: `steps` and `relations` are optional, for phase 1's measured reason (a required list not yet written makes lang-core drop the whole diagram while it streams, [F1](openui-diagrams.md#f1-the-components), M1; measured again for `steps`, M8); and the `Message`, `Entity` and `Relation` descriptions carry what the concept's "Need" column said (self-messages, methods for classes, kind for classes). `MindMap.root` stays required: the skill writes the root topic's statement (`top = Topic(…)`, F22) right after the `MindMap` line, so lang-core drops the map for at most the chunk between the two lines (M8); an optional `root` would print as `root?: Topic` and invite maps without a root.

**Text limits.** One object holds the limits every diagram type shares, and the readings take labels and ids from it:

```ts
/** Characters (code points) of a label before it is cut, and of an id (at least 1), for every diagram type. */
export const TEXT_LIMITS = { label: 120, id: 64 } as const;
```

`FLOWCHART_LIMITS` keeps its `label` and `id` keys (`definitions.ts:16-19`), written as `label: TEXT_LIMITS.label` and `id: TEXT_LIMITS.id`: the exported object has the same keys and values, so phase 1's tests do not change. `read.ts` reads `TEXT_LIMITS`; the three new limit objects hold counts only. `TEXT_LIMITS` lands in step 5.

**Parts.** One list of each diagram type's parts, read by the check (F15) and by `misplaced` (F14). It lands in step 5 with the `Flowchart` entry only; steps 6, 7 and 8 add `MindMap`, `EntityDiagram` and `SequenceDiagram` with their check entries, so the check never names a part the library does not have:

```ts
export const DIAGRAM_PARTS: Readonly<Record<DiagramType, readonly string[]>> = {
  Flowchart: ['Node', 'Edge', 'Group'],
  SequenceDiagram: ['Participant', 'Message', 'Note', 'Fragment', 'Section'],
  EntityDiagram: ['Entity', 'Field', 'Relation'],
  MindMap: ['Topic'],
};
export type DiagramType =
  | 'Flowchart'
  | 'SequenceDiagram'
  | 'EntityDiagram'
  | 'MindMap';
```

**Defaults.** `Message.kind` `call`; `Relation.kind` `association`; `notation` `er`; `direction` `down`; `layout` `right`; `height` per phase 1's F7. Every reading reads an optional prop that is absent or outside its schema (a `kind` not in its enum, a count not in `COUNTS`, a `key` not in `FIELD_KEYS`, a non-string `type` or `label`, a non-number `height`) as its default, or as unset where it has none (`fromCount`, `toCount`, `key`, `type`, `label`, `height`), without a finding, as phase 1 reads optional values (`model.ts`, F2). lang-core reports the type mismatch at close (M8).

**In the library.** `library.ts` calls the three definers beside `defineDiagramBuiltins` (`library.ts:29-35`); the parts draw nothing (`none`, `library.ts:21`) and the diagrams draw through `SequenceView`, `EntityView` and `MindMapView` (F17). `add` lists, after phase 1's four, `SequenceDiagram, Participant, Message, Note, Fragment, Section, EntityDiagram, Entity, Field, Relation, MindMap, Topic` (`library.ts:72`). None of the twelve names is among react-ui's 82 components (M8).

### F14. Reading

**Shared helpers.** `src/client/diagram/read.ts` (new) takes from `model.ts` the helpers phase 1 wrote for one type and generalizes the one that names it:

```ts
export type Props = Readonly<Record<string, unknown>>;
/** An OpenUI element as the parser returns it; moved from `check.ts:16-21`. */
export interface Element {
  readonly type: 'element';
  readonly typeName: string;
  readonly statementId?: string;
  readonly props: Props;
}
/** Moved from `check.ts:23-29`; the check imports it from here. */
export const isElement: (value: unknown) => value is Element;
/** `model.ts:63-64` unchanged. */
export const isRecord: (value: unknown) => value is Props;
/** `model.ts:66-67` unchanged: the value when it is a string. */
export const text: (value: unknown) => string | undefined;
/** `model.ts:69-83` unchanged. */
export const partsOf: (
  list: unknown,
  typeName: string,
  required: readonly string[],
) => readonly Props[];
/** Code points (`model.ts:85`). */
export const length: (value: string) => number;
/** `model.ts:88-89`: shortened past 24 characters, then JSON-escaped. */
export const quote: (text: string) => string;
/** `model.ts:92-95`, cut at `TEXT_LIMITS.label`. */
export const cutLabel: (label: string) => string;
/**
 * `model.ts:101-130` with the diagram's name; ids checked against `TEXT_LIMITS.id`:
 * `<Type> <id> is not drawn because an id has 1 to 64 characters.`,
 * `<Type> <id> appears twice, and only the first is drawn.`, and
 * `The <diagram> has <N> <plural>, and only the first <limit> are drawn: split the diagram.`
 */
export const keepUnique: (
  diagram: string,
  type: string,
  plural: string,
  parts: readonly Props[],
  limit: number,
  findings: string[],
) => { readonly kept: readonly Props[]; readonly before?: number };
/**
 * Each element of `list` (`isElement`) whose `typeName` is one of `DIAGRAM_PARTS.SequenceDiagram`
 * but not in `allowed` gives `A <Type> in <prop> is not drawn: <prop> holds <allowed>.`, `<allowed>`
 * joined with ", " and a final " and " (`Message, Note and Fragment`). Other entries are left to the caller.
 */
export const misplaced: (
  list: unknown,
  prop: 'steps' | 'sections',
  allowed: readonly string[],
  findings: string[],
) => void;
```

`readFlowchart` calls them with `'Flowchart'` and does not call `misplaced`; its findings, order and model do not change, and FT11 passes unchanged.

**Misplaced parts.** `readSequence` calls `misplaced` first on each `steps` list (the diagram's and every `Section`'s, allowed `Message`, `Note` and `Fragment`) and on each `sections` list (allowed `Section`). These are the nested lists, where the parts look alike and lang-core accepts any of them without an error (M8): a `Section` written straight into `steps` would otherwise vanish without a line in the error card. Flat lists (`participants`, `entities`, `fields`, `relations`, `children`, and phase 1's `nodes`, `edges` and `groups`) keep phase 1's rule and skip a foreign entry without a finding; a part of another diagram type gets F15's finding everywhere. Example: `A Section in steps is not drawn: steps holds Message, Note and Fragment.`

**Sequence.** `src/client/diagram/sequence-model.ts`:

```ts
export interface SeqParticipant {
  readonly id: string;
  readonly label: string;
}
export type SeqStep =
  | {
      readonly type: 'message';
      readonly from: string;
      readonly to: string;
      readonly text: string;
      readonly kind: 'call' | 'reply' | 'async';
    }
  | {
      readonly type: 'note';
      readonly text: string;
      readonly over: readonly string[];
    }
  | {
      readonly type: 'fragment';
      readonly kind: 'loop' | 'opt' | 'alt' | 'par';
      readonly sections: readonly SeqSection[];
    };
export interface SeqSection {
  readonly label: string;
  readonly steps: readonly SeqStep[];
}
export interface SequenceModel {
  readonly height?: number;
  readonly participants: readonly SeqParticipant[];
  /** Drawn steps, program order; every id they name is a drawn participant. */
  readonly steps: readonly SeqStep[];
  readonly cut: { readonly participants?: number; readonly steps?: number };
  readonly findings: readonly string[];
}
export const readSequence: (props: unknown) => SequenceModel;
```

Steps and findings, in order:

1. **Participants.** `keepUnique('SequenceDiagram', 'Participant', 'participants', …, 20)`.
2. **Steps**, depth-first in program order, each entry a `Message`, `Note` or `Fragment` element with its required props (misplaced parts reported as above; other entries skipped without a finding, as in phase 1):
   - A message naming no kept participant: `Message <from>→<to> names no Participant <missing>, so it is not drawn.`, `<missing>` the first of `from` and `to` that names none.
   - A note whose `over` is empty: `Note <text> names no Participant, so it is not drawn.`; one naming an id that is no kept participant: `Note <text> names no Participant <missing>, so it is not drawn.` (the first such id).
   - **The limit.** A _valid step_ is a message or note that passes the two rules above, or a fragment whose sections hold at least one valid step. Valid steps are numbered depth-first in program order, a fragment before the steps of its sections. A message or note is drawn when its number is at most 200; a fragment when its number is at most 200 and one of its sections holds a drawn step, so a fragment numbered 200 is not drawn and its number stays spent. When there are more than 200 valid steps: `The SequenceDiagram has <N> steps, and only the first 200 are drawn: split the diagram.`, `N` and `cut.steps` the number of valid steps. A fragment left empty by the limit gets no other finding.
   - A fragment whose sections hold no valid step: `Fragment <kind> <label> holds no step, so it is not drawn.`, `<kind>` as a JSON string and `<label>` the first section's label (`""` when there is none). It is not a valid step and takes no number. A section with no drawn step is kept inside a drawn fragment and drawn as an empty band.
3. **Labels.** Participant labels, message texts, note texts and section labels are cut as phase 1 cuts labels: `The label of Participant <id> is cut at 120 characters.`, `The text of Message <from>→<to> is cut at 120 characters.`, `The text of Note <text> is cut at 120 characters.`, `The label of Section <label> is cut at 120 characters.` An empty participant label draws the id.
4. **Empty diagram.** No kept participant: `The SequenceDiagram has no participants.`

In every finding of the three readings, `<id>`, `<from>`, `<to>`, `<missing>`, `<text>` and `<label>` are written with `quote` (shortened past 24 characters, then JSON-escaped), as phase 1 writes ids (`model.ts:114,282`): `Message "api"→"db" names no Participant "db", so it is not drawn.` Defaults apply as F13 states (`call` for a message's `kind`, `loop` for a fragment's).

**Entities.** `src/client/diagram/entity-model.ts`:

```ts
export interface EntityField {
  readonly name: string;
  readonly type?: string;
  readonly key?: 'pk' | 'fk' | 'pk-fk' | 'unique';
}
export interface EntityBox {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly EntityField[];
  /** Always empty under `er`. */
  readonly methods: readonly string[];
}
export interface EntityRelation {
  readonly from: string;
  readonly to: string;
  /** `association` under `er`, whatever was written. */
  readonly kind: (typeof RELATION_KINDS)[number];
  readonly label?: string;
  readonly fromCount?: (typeof COUNTS)[number];
  readonly toCount?: (typeof COUNTS)[number];
}
export interface EntityModel {
  readonly notation: 'er' | 'class';
  readonly direction: 'down' | 'right';
  readonly height?: number;
  readonly entities: readonly EntityBox[];
  readonly relations: readonly EntityRelation[];
  readonly cut: { readonly entities?: number; readonly relations?: number };
  readonly findings: readonly string[];
}
export const readEntities: (props: unknown) => EntityModel;
```

Steps and findings, in order:

1. **Entities.** `keepUnique('EntityDiagram', 'Entity', 'entities', …, 60)`.
2. **Members.** `Field` elements with a string `name` and `methods` entries that are strings, all of them, in program order (other entries skipped without a finding, as in phase 1). UD12 sets no member limit, and none is added: a tall entity makes a tall picture, which the frame fits into its clamped height and pans and zooms as it does any size ([F7](openui-diagrams.md#f7-drawing), `canvas.tsx:33-34`). Under `er`, methods are not read and give no finding: an ER diagram has no methods (UD10), and the skill says so (F22).
3. **Relations.** A `from` or `to` naming no kept entity: `Relation <from>→<to> names no Entity <missing>, so it is not drawn.`, `<missing>` the first of the two that names none; beyond 120: `The EntityDiagram has <N> relations, and only the first 120 are drawn: split the diagram.` Self-relations and repeats are drawn. Under `er`, `kind` reads as `association` with no finding, so a class kind written in an ER diagram draws a plain relation.
4. **Labels.** Entity names, field names and types, methods and relation labels are cut at 120 characters: `The name of Entity <id> is cut at 120 characters.`, `A field of Entity <id> is cut at 120 characters.`, `A method of Entity <id> is cut at 120 characters.`, `The label of Relation <from>→<to> is cut at 120 characters.` (each at most once per entity or relation). An empty name draws the id.
5. **Empty diagram.** `The EntityDiagram has no entities.`

**Mind maps.** `src/client/diagram/mindmap-model.ts`:

```ts
export interface MindTopic {
  readonly label: string;
  /** 1 for the root. */
  readonly depth: number;
  readonly children: readonly MindTopic[];
}
export interface MindMapModel {
  readonly layout: 'right' | 'down';
  readonly height?: number;
  /** Absent when `root` is not a Topic element with a string label. */
  readonly root?: MindTopic;
  /** The number of drawn topics. */
  readonly count: number;
  readonly cut: { readonly topics?: number };
  readonly findings: readonly string[];
}
export const readMindMap: (props: unknown) => MindMapModel;
```

Steps and findings, in order:

1. **Depth.** A topic at level 9: `Topic <path> is deeper than 8 levels, so it and its subtopics are not drawn.` (one finding per such topic, preorder).
2. **Count.** Topics within 8 levels are kept in preorder up to 300; beyond: `The MindMap has <N> topics, and only the first 300 are drawn: split the diagram.`, `N` and `cut.topics` the number of topics within 8 levels (those step 1 drops are not counted). A kept topic's children beyond the cut are dropped.
3. **Labels.** `The label of Topic <path> is cut at 120 characters.` An empty label draws as an empty box.
4. **Empty diagram.** No root, or a root that is not a `Topic` element with a string `label`: `The MindMap has no topics.`

`<path>` is the topic path (Terms): each label shortened past 24 characters as ids are, joined by `›` and quoted once (`"Launch › Marketing › Ads"`). Entries of `children` that are not `Topic` elements with a string `label` are skipped with their subtopics, without a finding, as phase 1 skips foreign entries; a part of another diagram gets F15's finding.

### F15. The check

`src/client/diagram/check.ts` replaces its `PARTS` set (`check.ts:11`) and `Flowchart` test (`:80-85`) with one table over F13's `DIAGRAM_PARTS`, and imports `Element` and `isElement` from `read.ts` instead of declaring them (`check.ts:16-29`):

```ts
const DIAGRAMS: Readonly<
  Record<
    string,
    {
      readonly read: (props: unknown) => {
        readonly findings: readonly string[];
      };
      readonly parts: readonly string[];
    }
  >
> = {
  Flowchart: { read: readFlowchart, parts: DIAGRAM_PARTS.Flowchart },
  SequenceDiagram: { read: readSequence, parts: DIAGRAM_PARTS.SequenceDiagram },
  EntityDiagram: { read: readEntities, parts: DIAGRAM_PARTS.EntityDiagram },
  MindMap: { read: readMindMap, parts: DIAGRAM_PARTS.MindMap },
};
```

The walk (`check.ts:73-88`) carries the type of the nearest enclosing diagram instead of a boolean. A diagram element adds its reading's findings to its statement, as a `Flowchart` does in phase 1. A part whose diagram is not the enclosing one gives `<Part> draws only inside a <Diagram>.` on its statement: a `Topic` in a `Stack`, a `Node` inside a `MindMap`. A diagram inside another diagram's props (a `Flowchart` in a `Topic`'s `children`, a `MindMap` in `steps`), which the outer reading skips, gives `<Inner> is not drawn inside a <Outer>.` on its own statement; the walk does not descend into it, so its parts and its reading add nothing. This rule lands in step 6; phase 1 gave a nested `Flowchart` no line. The message format, its fitting into the reporter's 300 UTF-16 code units, `mergeDiagramErrors` and the attribution to the diagram's statement are phase 1's (`check.ts:35-49,90-131`; [F3](openui-diagrams.md#f3-findings-in-the-check)). A mind map's topics written as branch statements (F22) carry their own `statementId` (M8), but their findings still go to the `MindMap`'s statement, which the topic path identifies.

### F16. The outline

`src/client/diagram/outline.tsx` keeps its look and splits the Flowchart text from the component:

```ts
export interface OutlineItem {
  readonly key: string;
  readonly text: string;
  readonly children?: readonly OutlineItem[];
}
export interface OutlineList {
  readonly title: string;
  readonly items: readonly OutlineItem[];
}
export interface OutlineText {
  readonly header: string;
  readonly lists: readonly OutlineList[];
}
/** The root carries `id`; lists in order, each omitted when empty; children as nested `<ul>`s. */
export function Outline(props: {
  readonly text: OutlineText;
  readonly note?: string;
  readonly hidden: boolean;
  readonly id: string;
}): ReactNode;
export const flowchartOutline: (model: FlowchartModel) => OutlineText;
export const sequenceOutline: (model: SequenceModel) => OutlineText;
export const entityOutline: (model: EntityModel) => OutlineText;
export const mindMapOutline: (model: MindMapModel) => OutlineText;
```

`flowchartOutline` returns phase 1's header and lists (`outline.tsx:19-27,65-89`), so the Flowchart outline does not change; `outlineHeader` (`outline.tsx:19`) stays and returns `flowchartOutline(model).header`. The others, counts written as phase 1 writes them (`1 node`, `100 of 130 nodes`):

- **Sequence.** Header `Sequence diagram: <p> participants, <s> steps`. Lists `Participants` (labels) and `Steps`: a message `<from label> → <to label>: <text>`, with ` (reply)` or ` (async)` after `<to label>` for those kinds; a note `Note over <labels joined by ", ">: <text>`; a fragment `<kind>` with one child per section, `<label>` (or `<kind>` when the label is empty), whose children are its steps.
- **Entities.** Header `ER diagram: <e> entities, <r> relations` or `Class diagram: …`. Lists `Entities`: `<name>` with one child per field, `<name>: <type>` with ` (PK)`, ` (FK)`, ` (PK, FK)` or ` (unique)`, and, under `class`, one child per method; `Relations`: `<from name> → <to name>`; under `class`, ` (<kind>)` when the kind is not `association`; when either count is set, ` <fromCount> to <toCount>`, an unset count written `?`; then `: <label>` when the label is not empty. Examples: `users → orders 1 to *: places`, `users → orders 1 to ?`, `Dog → Animal (inherits)`.
- **Mind map.** Header `Mind map: <t> topics` (`layout` `right`) or `Tree: <t> topics` (`down`). One list, `Topics`, nesting as the tree does.

The SVG's `aria-label` is the header, as in phase 1 (`canvas.tsx:243`).

### F17. Views and states

`src/client/diagram/view.ts` (new) holds the state machine `FlowchartView` has in phase 1 (`flowchart.tsx:75-114`):

```ts
export type Drawn<D> =
  | { readonly state: 'pending' }
  | { readonly state: 'drawn'; readonly value: D }
  | { readonly state: 'failed'; readonly message: string };
/**
 * Runs `draw` once per `key` while `drawable`, drops results that arrive after the
 * key changed or the component unmounted, and cuts a failure's message to 200 characters.
 */
export const useDrawn: <D>(
  key: string,
  drawable: boolean,
  draw: () => Promise<D>,
) => Drawn<D>;
export const NOTES: {
  readonly noContext: 'Diagrams are drawn only in the conversation.';
  readonly streaming: 'The diagram is drawn when its fence is complete.';
  readonly pending: 'Drawing the diagram…';
  readonly failed: 'This diagram could not be drawn: ';
};
```

`FlowchartView` uses it with no change in behavior (FT13 and FT15 pass unchanged). `SequenceView`, `EntityView` and `MindMapView` (in `sequence.tsx`, `entity.tsx`, `mindmap.tsx`) follow phase 1's state table ([F4](openui-diagrams.md#f4-streaming-the-outline-and-the-states)) with their own model, outline and empty test (no participant, no entity, no root). Their keys are the JSON of the drawn model without `height`, `findings` and `cut`, as `keyOf` leaves out all but the drawn parts and the direction (`flowchart.tsx:48-49`): a patch that changes only `height` re-runs no layout, and the frame applies the new height (`canvas.tsx:365-370`). Their `draw`:

Their props, as react-lang passes them, read only through the readings (as `FlowchartProps`, `flowchart.tsx:21-27`):

```ts
// sequence.tsx
export interface SequenceProps {
  readonly participants?: unknown;
  readonly steps?: unknown;
  readonly height?: unknown;
}
export function SequenceView(
  props: ComponentRenderProps<SequenceProps>,
): ReactNode;
// entity.tsx
export interface EntityProps {
  readonly entities?: unknown;
  readonly relations?: unknown;
  readonly notation?: unknown;
  readonly direction?: unknown;
  readonly height?: unknown;
}
export function EntityView(props: ComponentRenderProps<EntityProps>): ReactNode;
// mindmap.tsx
export interface MindMapProps {
  readonly root?: unknown;
  readonly layout?: unknown;
  readonly height?: unknown;
}
export function MindMapView(
  props: ComponentRenderProps<MindMapProps>,
): ReactNode;
```

- `EntityView`: `sizeEntities` (F21), `entityGraph` (F18), `layout` from the fence context.
- `MindMapView`: `sizeMindMap`, `mindMapGraph`, `layout`.
- `SequenceView`: `layoutSequence(model, measure)` (F19); it never reads the context's `layout`, so a sequence diagram never loads the layout chunk (G5, FT32).

### F18. The layout chunk

**Types.** `src/client/diagram/layout-types.ts` (`:10-60`) gains, all optional so that phase 1's graphs are unchanged:

```ts
export interface LayoutGraph {
  /** `layered` when absent. `mrtree` takes no groups, and its edges form one tree. */
  readonly algorithm?: 'layered' | 'mrtree';
  /** The drawing puts markers on edge ends (entity diagrams): `layered` adds the marker options. */
  readonly markerSpacing?: true;
  /**
   * Edges may carry end labels (class diagrams, with or without counts written): a `right`
   * graph is laid out transposed.
   */
  readonly transposeRight?: true;
  // … direction, groupPadding, nodes, groups as in phase 1
  readonly edges: readonly {
    // … key, from, to, label as in phase 1
    /** Placed by ELK at the source end (`TAIL`) and the target end (`HEAD`); `layered` only, no groups. */
    readonly tailLabel?: { readonly width: number; readonly height: number };
    readonly headLabel?: { readonly width: number; readonly height: number };
  }[];
}
export interface LayoutResult {
  // … as in phase 1; each edge also has `tailLabel?: Box` and `headLabel?: Box` when the graph had them
}
```

**The chunk.** `src/client/chunks/layout.ts`:

- **Options.** `layered` with phase 1's options (`layout.ts:122-130`), plus F18's marker options when the graph has `markerSpacing`. `mrtree`: `elk.algorithm` `mrtree`, `elk.direction` `DOWN` or `RIGHT`, `elk.spacing.nodeNode` `16`, `elk.randomSeed` `1`, `elk.json.shapeCoords` and `elk.json.edgeCoords` `ROOT`. Both algorithms are in `elk.bundled.js`, which registers every algorithm by default (`elk.bundled.js:23-62`); the chunk's one ELK instance (`layout.ts:54,227`) serves both.
- **Marker options.** With `markerSpacing`: `elk.layered.spacing.edgeNodeBetweenLayers` `24`, `elk.layered.spacing.nodeNodeBetweenLayers` `48`, `elk.spacing.nodeSelfLoop` `20` and `elk.spacing.edgeLabel` `8`. ELK does not know the markers' size; these options keep every end segment at least as long as the longest marker (18 px, F20), every self-relation's end segments too, both markers of a short relation apart, and end labels 8 px off their line, more than half a marker's 12 px width. Measured (M9): with phase 1's options alone, 27–103 end segments per fixture set were shorter than their marker; with these, none.
- **End labels.** A labelled end becomes an ELK label of that size with `elk.edgeLabels.placement` `TAIL` or `HEAD`. Each label carries an id, `<key>:c` for the centre label, `<key>:t` for the tail and `<key>:h` for the head, and the result reads each back by id instead of taking the first (`layout.ts:196-199`).
- **Transposed layout.** When `direction` is `right` and the graph has `transposeRight`, the chunk swaps every width and height, lays the graph out `DOWN`, and swaps x with y and width with height in every box and point of the result. `entityGraph` sets `transposeRight` for every `class` diagram, with or without counts, so writing a first count does not switch the layout family; an `er` diagram carries no end labels (its counts are markers) and is laid out by ELK's own `RIGHT`. Measured (M9): ELK's own `RIGHT` puts end labels on top of each other (249 overlapping pairs over the five 60/120 fixtures, under each option M9 lists); the transposed layout has none.
- **Validation** (`problemOf`, `layout.ts:57-88`) adds: `mrtree` with a group, a node with two incoming edges, or an edge loop rejects with `Invalid layout graph: the graph is not a tree`; `mrtree` with an end label, `markerSpacing` or `transposeRight` rejects with `Invalid layout graph: layered options on an mrtree graph`; end labels with groups reject with `Invalid layout graph: end labels with groups`. As phase 1's checks are ([F6](openui-diagrams.md#f6-the-layout-chunk-and-the-layout-loader): repeated keys, missing keys and group loops, which `readFlowchart` already removes), both are unreachable from the graphs `mindMapGraph` and `entityGraph` build; they keep the chunk's contract that any `LayoutGraph` either lays out or rejects with `Invalid layout graph:` before ELK runs, where ELK's `mrtree` on a non-tree and its label placement with groups are not specified.
- **Measured** (M9, M10): on the entity fixtures 10/12, 30/50 and 60/120, both notations and directions, with self-relations, repeated and opposite relations and every count: zero box overlaps, relations through a box, labels or end labels on a box, label overlaps, short end segments and markers on another entity; markers touching another marker or an end label remain at the rates FR20 gives. On the mind-map fixtures 30/3, 100/5 and 300/8 in both directions with ELK's own edge routes: zero defects. The same geometry for the same input. Slowest layout: 114 ms at 60/120, 94 ms at 300/8.

**Graphs.** `src/client/diagram/graph.ts` keeps `toLayoutGraph` (`graph.ts:17-61`) and adds:

```ts
/**
 * Entity i → `n<i>`, relation i → `e<i>`, `layered`, `markerSpacing`, `transposeRight` under `class`,
 * the model's direction, no groups.
 * Under `class`, an `inherits` or `implements` relation runs from the parent (`to`) to the
 * child (`from`), so parents sit above (`down`) or left of (`right`) their children; the
 * drawing reverses its points. Labels: the relation's label as `label`; under `class`, the
 * counts as `tailLabel` (fromCount) and `headLabel` (toCount), swapped with the ends when reversed.
 */
export const entityGraph: (
  model: EntityModel,
  sizes: EntitySizes,
) => LayoutGraph;
/** Topic i in preorder → `n<i>`, edge to each child → `e<i>` (i of the child), `mrtree`, direction from `layout`. */
export const mindMapGraph: (
  model: MindMapModel,
  sizes: MindMapSizes,
) => LayoutGraph;
```

Under `er`, counts are drawn as crow's-foot markers on the line (F20) and need no label.

### F19. Sequence layout

`src/client/diagram/sequence-layout.ts` (new), pure, in the renderer chunk:

```ts
export interface SequenceLayout {
  readonly width: number;
  readonly height: number;
  /** One per participant: its header box and its lifeline's x. */
  readonly columns: readonly {
    readonly header: Box;
    readonly x: number;
    readonly label: TextBlock;
  }[];
  /** Lifelines run from `top` to `bottom`. */
  readonly top: number;
  readonly bottom: number;
  /** One per drawn step, depth-first, in program order. */
  readonly steps: readonly SequenceStepBox[];
}
export type SequenceStepBox =
  | {
      readonly type: 'message';
      readonly points: readonly Point[];
      readonly label: Box;
      readonly text: TextBlock;
      readonly kind: 'call' | 'reply' | 'async';
    }
  | { readonly type: 'note'; readonly box: Box; readonly text: TextBlock }
  | {
      readonly type: 'fragment';
      readonly box: Box;
      /** The kind tab at the box's top left. */
      readonly tab: Box;
      readonly kind: string;
      /** Each section's label line; `y` is its top, where a separator is drawn after the first. */
      readonly sections: readonly {
        readonly y: number;
        readonly label: TextBlock;
      }[];
    };
export const layoutSequence: (
  model: SequenceModel,
  measure: Measure,
) => SequenceLayout;
```

**Metrics.** `sequence-layout.ts` keeps its constants, in px, in a module-private object, and uses phase 1's `DIAGRAM_METRICS` (`measure.ts:23-53`) for `lineHeight` (18), `nodePadding` (10), `edgeLabelPadding` (4) and `maxWidth` (`box` 160, `edge` 140). FT29 checks the rules below, not these values:

```ts
const SEQUENCE_METRICS = {
  /** Around the whole drawing. */
  margin: 16,
  /** Between two neighbouring headers. */
  gap: 40,
  /** From the headers' bottom to the first row. */
  headerGap: 16,
  /** Above and below each row's content. */
  rowPadding: 8,
  /** From a message's label plate down to its arrow. */
  arrowGap: 6,
  /** Between a lifeline and a label plate or note edge beside it. */
  side: 8,
  /** A self-message's loop. */
  selfWidth: 32,
  selfHeight: 20,
  /** A fragment's padding around its content and below its last section. */
  inset: 10,
  /** Around the text of a kind tab and of a section label line. */
  tabPadding: 4,
  /** Around a note's text. */
  notePadding: 8,
} as const;
```

**Rules.** In order; rules 1–4 place everything with the first lifeline at x = 0, and rule 5 shifts the drawing right so nothing lies left of the margin.

1. **Headers.** Each participant's label (its id when the label is empty) wrapped to `maxWidth.box` and padded by `nodePadding`; every header takes the tallest header's height, top at `margin`.
2. **Columns.** The gap between lifelines i and i + 1 starts at half the two headers' widths plus `gap`. Then every message, depth-first, sorted by span (the difference of its two participants' indexes, smallest first, program order within a span), states a need: a message between two lifelines needs its label plate (its text wrapped to `maxWidth.edge`, padded by `edgeLabelPadding`) plus `side` on each side between them, and when the lifelines are closer, the gap just left of the right one grows by the difference; a self-message needs `selfWidth + side + plate width + side` right of its lifeline, and when the lifeline has a right neighbour, the gap to it grows to that. Gaps only grow, so a need met stays met. Notes state no need.
3. **Rows.** From `margin + header height + headerGap`, each step takes the next band, depth-first in program order:
   - A message: its plate at the band's top plus `rowPadding`, centred between its two lifelines; its arrow `arrowGap` below the plate, from lifeline to lifeline; the band ends `rowPadding` below the arrow.
   - A self-message: a loop from its lifeline `selfWidth` to the right and `selfHeight` down, starting at the band's top plus `rowPadding`; its plate `side` right of the loop, at the same top; the band ends `rowPadding` below the taller of the two.
   - A note: its text wrapped to `maxWidth.box` and padded by `notePadding`; as wide as that, or as the span of its lifelines plus `side` on each side when that is wider; centred on the middle of that span; top at the band's top plus `rowPadding`; the band ends `rowPadding` below it.
   - A fragment: its box's top is the band's top. The kind tab (the kind's text, one line, padded by `tabPadding`, so `lineHeight + 2 × tabPadding` high) sits at the box's top left. Then, per section, from the tab's bottom: a label line of the same height (`[<label>]` at `tabPadding` from its top; empty when the label is), whose top is the section's `y` and where a dashed separator is drawn for every section after the first; then the section's steps. After the last section, `inset`. The fragment's band ends there.
     Every box, plate and point of a step lies inside its band, so steps in different bands never meet.
4. **Fragment boxes.** A fragment's left and right edges are those of everything inside it (message arrows and plates, self-message loops and plates, notes, nested fragments' boxes) widened by `inset` on each side; then the right edge moves right until the tab plus `inset`, and every section label plus `inset` on each side, fit. Nested fragments are placed first, so a parent's box holds its children's boxes with `inset` to spare.
5. **Size.** The leftmost edge of every header, plate, loop, note and fragment box is moved to `margin` by shifting every x. The width runs to the rightmost edge plus `margin`; the height to the last band's end plus `margin`. Lifelines run from the headers' bottom to the last band's end.

Measured (M11): a prototype of these rules finds no FT29 defect on the sequence fixtures; version 2's rules, which bounded fragments by lifelines only and did not shift, fail it on every fixture set.

### F20. Drawing

**The frame.** `canvas.tsx` splits the body of `DiagramCanvas` (`canvas.tsx:355-444`) into a shared frame and phase 1's picture. `DiagramCanvas` stays, with its props and behavior, as the Flowchart's wrapper of the two, so `FlowchartView` (`flowchart.tsx:117`) and `tests/client/diagram-drawing.test.ts` (`:15,291,328,347,410,424`) keep calling it unchanged:

```ts
/** The area, its height (phase 1's F7 bounds), the viewport and the toolbar; `children` is the SVG. */
export function DiagramFrame(props: {
  readonly content: { readonly width: number; readonly height: number };
  readonly writtenHeight?: number;
  readonly interactive: boolean;
  /** The area's label when interactive: `<Type>, pan and zoom`. */
  readonly areaLabel: string;
  readonly children: ReactNode;
}): ReactNode;
/** Phase 1's `Picture` (`canvas.tsx:200-340`), exported under this name. */
export function FlowchartPicture(props: {
  readonly model: FlowchartModel;
  readonly sizes: Sizes;
  readonly result: LayoutResult;
  readonly outlineId: string;
}): ReactNode;
/** Phase 1's signature (`canvas.tsx:355-362`): `DiagramFrame` with `Flowchart, pan and zoom` around `FlowchartPicture`. */
export function DiagramCanvas(props: {
  readonly model: FlowchartModel;
  readonly sizes: Sizes;
  readonly result: LayoutResult;
  readonly interactive: boolean;
  readonly outlineId: string;
}): ReactNode;
```

The three new pictures, one per file, each one `svg[role="img"]` sized to its content:

```ts
// sequence-picture.tsx
export function SequencePicture(props: {
  readonly model: SequenceModel;
  readonly layout: SequenceLayout;
  readonly outlineId: string;
}): ReactNode;
// entity-picture.tsx
export function EntityPicture(props: {
  readonly model: EntityModel;
  readonly sizes: EntitySizes;
  readonly result: LayoutResult;
  readonly outlineId: string;
}): ReactNode;
// mindmap-picture.tsx
export function MindMapPicture(props: {
  readonly model: MindMapModel;
  readonly sizes: MindMapSizes;
  readonly result: LayoutResult;
  readonly outlineId: string;
}): ReactNode;
```

`FlowchartView` renders `DiagramCanvas`, as in phase 1; the three new views render `DiagramFrame` (content: the layout's or result's width and height; `writtenHeight`: the model's `height`; `interactive`: `fence.interactive`, as `flowchart.tsx:121`) around their picture. `Label`, the `fill` and `stroke` helpers and `TEXT_STYLE` (`canvas.tsx:56-103`) are exported for the other pictures. Every picture is one `svg[role="img"]` with its outline's header as `aria-label` (`flowchartOutline(model).header` and its three siblings, F16) and `aria-describedby` the outline's id. Area labels: `Sequence diagram, pan and zoom`, `ER diagram, pan and zoom` or `Class diagram, pan and zoom`, `Mind map, pan and zoom` or `Tree, pan and zoom`.

**Sequence picture.** `sequence-picture.tsx` draws headers as `box` shapes with `nodeFill` and `nodeStroke`; lifelines dashed in `edge`. Messages: `call` solid with a filled arrowhead, `reply` dashed with an open arrowhead, `async` solid with an open arrowhead (the concept's table); a self-message a three-segment loop to the right. Notes: a rectangle with `group2` fill and `groupStroke`, text in `groupText`. Fragments: an unfilled rectangle in `groupStroke`, a kind tab at its top left with `group1` fill and the kind in `groupText`, section labels in brackets (`[valid]`) at each section's top left, sections after the first separated by a dashed line. Paint order: fragments from the outermost, lifelines, headers, notes, messages, labels.

**Entity picture.** In `entity-picture.tsx`, an entity is a rectangle (`nodeFill`, `nodeStroke`) with a header band (`group1` fill) holding the name, then one row per field: under `er`, a key column (`PK`, `FK`, `PK FK`, `UQ`) and `name type`; under `class`, `name: type`; then, under `class`, a separator line and one row per method. Relations are paths through the result's points, reversed for reversed relations (F18), in `edge`:

| Under `class` | Line   | At `from`      | At `to`         |
| ------------- | ------ | -------------- | --------------- |
| `association` | solid  | —              | —               |
| `inherits`    | solid  | —              | hollow triangle |
| `implements`  | dashed | —              | hollow triangle |
| `composition` | solid  | filled diamond | —               |
| `aggregation` | solid  | hollow diamond | —               |
| `dependency`  | dashed | —              | open arrowhead  |

Under `class`, counts are text in the end-label boxes. Under `er`, every relation is a solid line, and each end with a count carries a crow's-foot marker: `1` one bar, `0..1` a circle and a bar, `*` a circle and a crow's foot, `1..*` a bar and a crow's foot. Hollow markers fill with `nodeFill`. Each marker fits a box along its line from the end, length × width: `1` 8 × 12 px, `0..1` 14 × 12, `*` 18 × 12, `1..*` 12 × 12, a triangle 12 × 12, a diamond 16 × 10, an open arrowhead 10 × 10; F18's marker options and FT27 use these boxes. The relation's label sits on a plate at its label box, as phase 1's edge labels do.

**Mind-map picture.** `mindmap-picture.tsx` draws topics as `round` shapes (phase 1's stadium, `canvas.tsx:118-128`) with their labels; the root with `group2` fill, the others `nodeFill`; edges as polylines through ELK's points in `edge`, without arrowheads.

**Colors.** Every fill and stroke is one of phase 1's roles (`colors.ts:5-36`), and every text sits on a fill FT16 already checks (`groupText` on `group1`–`group4`, `nodeText` on `nodeFill`, `edgeText` on `labelPlate`). FT16 does not change.

### F21. Measuring

`src/client/diagram/measure.ts` keeps its font, metrics and functions (`measure.ts:23-223`) and adds:

```ts
export interface EntitySizes {
  /** Under `er`, the key column's width, `measure('PK FK ')`, the same for every entity; 0 under `class`. */
  readonly keyColumn: number;
  readonly entities: readonly {
    readonly name: TextBlock;
    /** One line per field (`name type` under `er`, `name: type` under `class`, `name` without a type), then one per method; never wrapped. */
    readonly rows: readonly string[];
    readonly width: number;
    readonly height: number;
  }[];
  /** Padded, as phase 1's edge labels; `undefined` when unlabelled. */
  readonly labels: readonly (
    | (TextBlock & { readonly boxWidth: number; readonly boxHeight: number })
    | undefined
  )[];
  /** Under `class`, the count texts' padded boxes. */
  readonly tails: readonly (
    | { readonly width: number; readonly height: number }
    | undefined
  )[];
  readonly heads: readonly (
    | { readonly width: number; readonly height: number }
    | undefined
  )[];
}
export const sizeEntities: (
  model: EntityModel,
  measure: Measure,
) => EntitySizes;
export interface MindMapSizes {
  /** Preorder; labels wrapped to `maxWidth.round`, padded as nodes. */
  readonly topics: readonly {
    readonly label: TextBlock;
    readonly width: number;
    readonly height: number;
  }[];
}
export const sizeMindMap: (
  model: MindMapModel,
  measure: Measure,
) => MindMapSizes;
```

An entity's size, with `DIAGRAM_METRICS` (`lineHeight` 18, `nodePadding` 10, `edgeLabelPadding` 4):

- **Width:** the widest of `measure(name)`, `keyColumn + measure(row)` for each field row, and `measure(method)` for each method row, plus 2 × `nodePadding`.
- **Height:** a header band of `lineHeight + 2 × nodePadding` (38 px), then `lineHeight` per row, then `nodePadding` below the rows; under `class` with at least one method, `nodePadding` more for the separator between fields and methods.
- **Labels:** a relation's label as phase 1's edge labels (wrapped to `maxWidth.edge`, padded by `edgeLabelPadding`); under `class`, each count as one line padded by `edgeLabelPadding`: `measure(count) + 8` by 26 px.

Under `er`, each field row is drawn as its key text (`PK`, `FK`, `PK FK`, `UQ` or nothing) in the key column, then the row text. Sequence sizes are measured inside `layoutSequence` with the same `Measure`. Each view passes all of its labels to `createMeasure`, as `labelsOf` does (`flowchart.tsx:52-55`), so the faces their characters need are loaded first ([F5](openui-diagrams.md#f5-measuring-and-sizing)). Rows are never wrapped: a field row is at most a 120-character name and a 120-character type (F14), so under the estimate an entity is at most 1,947 px wide (the key column's 6 characters, the name, a space and the type: 247 characters × 7.8 px, plus 2 × `nodePadding`).

### F22. The skill

**Rules.** Phase 1's four diagram rules (`tests/client/skill-text.test.ts:64-69`) are replaced by five that cover all four types, in this order and wording; the Doric rules go from 14 (10 not about diagrams, then phase 1's 4) to 15:

```text
Draw structure with a diagram and numbers with a chart: a Flowchart for a process, a pipeline or an architecture with regions (groups); a SequenceDiagram for messages over time; an EntityDiagram for tables ("er") or classes ("class"); a MindMap for a mind map ("right") or a tree ("down"). Put a diagram at the root or in a Stack.
Write a diagram right after root, then its lists in this order, each on one line: `chart = Flowchart(nodes, edges, groups, "down")`, `nodes`, `groups` (`[]` when none), `edges`; `seq = SequenceDiagram(participants, steps)`, `participants`, `steps`; `model = EntityDiagram(entities, relations, "er")`, `entities`, `relations`; `map = MindMap(top, "right")`, then `top = Topic("…", [b1, b2])` and one statement per branch, `b1 = Topic("…", [Topic(…), …])`. To change a diagram, patch only the statements that change, each written whole.
Ids have 1 to 64 characters and are unique among a diagram's parts of one type. Edges, messages, notes and relations name ids of their own diagram; a Node's group and a Group's parent name Groups of the same Flowchart. Never give positions, sizes or colors: the app lays diagrams out.
Limits per diagram: Flowchart 100 nodes, 200 edges, 25 groups nested 4 deep; SequenceDiagram 20 participants, 200 steps; EntityDiagram 60 entities, 120 relations; MindMap 300 topics, 8 levels. Labels are cut at 120 characters. Split anything larger.
In a class diagram, methods are plain strings such as "save(): void"; inherits and implements point from the child to the parent, composition and aggregation from the whole to the part.
```

The second rule keeps phase 1's measured order for flowcharts (`nodes` before `groups` before `edges`, [F10](openui-diagrams.md#f10-lists-and-the-skill)) and its `groups = []` form, and gives each type its lists in the order that keeps the diagram in the render while they stream: the participants, entities or root topic before the steps or relations (F13). First-level branches are statements of their own, so a patch rewrites the branch it changes (F23); sequence steps stay one inline list. The fifth carries UD10 and the direction of the class kinds the drawing assumes (F18, F20).

**Generated text.** The test's `generate` (`skill-text.test.ts:76-110`) adds the twelve after phase 1's four, in F13's library order, and `OPENUI_SKILL_UPDATE=1` rewrites `src/host/skills/openui.md`. Measured (M7): the twelve signatures add 1,624 characters to phase 1's 626 (as built); the five rules take 1,597, their 1,582 characters plus 3 per rule for the `- ` and line break the prompt builder adds; both phases together add 3,847 characters as built (the prototype measured 3,858), against G6's 4,000.

### F23. Lists

P4's inline lists stay, as phase 1 measured ([F10](openui-diagrams.md#f10-lists-and-the-skill)); phase 2 splits only a mind map's first-level branches into statements. Token counts (M12, gpt-tokenizer's `o200k_base`, 5 seeds; a patch adds one topic under a topic chosen uniformly, or one message to a list chosen in proportion to its length; medians unless marked):

| Mind map, tokens                              | Write 30/3 | Write 100/5 | Write 300/8 | Patch 30/3 | Patch 100/5 | Patch 300/8 (p90) |
| --------------------------------------------- | ---------- | ----------- | ----------- | ---------- | ----------- | ----------------- |
| One statement (`top = Topic(…)`)              | 202        | 685         | 2,093       | 199        | 681         | 2,087 (2,109)     |
| One statement per first-level branch (chosen) | 240        | 717         | 2,134       | 34         | 196         | 1,070 (1,248)     |

The branch form costs 2–19 % more to write. A patch rewrites the branch it changes: a fifth of the whole map at 30/3, half at 300/8, where the generator's 5–8 first-level branches are large; a new branch, as the acceptance patch asks, is 52–61 tokens instead of the whole map.

| Sequence, tokens                            | Write 3/12 | Write 8/50 | Write 20/200 | Patch 3/12 | Patch 8/50 | Patch 20/200 (p90) |
| ------------------------------------------- | ---------- | ---------- | ------------ | ---------- | ---------- | ------------------ |
| Steps inline in one list (chosen)           | 218        | 879        | 3,347        | 188        | 807        | 3,131 (3,187)      |
| One statement per `Section`                 | 224        | 923        | 3,477        | 169        | 160        | 244 (766)          |
| One statement per step, lists of references | 289        | 1,171      | 4,522        | 58         | 76         | 103 (205)          |

The sequence fixtures hold 20 % of their steps at the top level at 8/50 and 20/200 and 77 % at 3/12, so they favour section statements. Sequences shaped like acceptance prompts 1–4 (12, 12, 7 and 15 steps, 12, 5, 2 and 6 of them at the top level) cost 122–200 tokens to patch inline and 34–88 with section statements, while every write costs 5.3 % more (807 against 850 tokens for the four) (M12). At the sizes the prompts produce, section statements save about 100 tokens per patch and add a clause to the skill, so steps stay inline; a statement per step would cut every patch to about 100 tokens at 20/200 but costs 30–35 % more on every write.

### F24. Version and contracts

- `openui` stays at 2.2.0 in `manifest.json`: phase 1's bump is unreleased and uncommitted, both phases ship in one commit, and a version names what a release delivers. The `description` already says "diagrams laid out by the app"; it does not change.
- `openui.programs/v1`, `openui.questions/v1`, `openui.answered/v1`, `chat.views/v1` and `openui/contracts` do not change; findings use `runtime-error` as in phase 1.
- `packages/desktop` and `papercraft` do not change.
- **Rollback.** Going back to 2.1.0 draws OpenUI's `unknown-component` card for every diagram fence, flowcharts included; nothing persisted changes. Phase 2 alone is withdrawn by a 2.2.1 that removes the twelve components from `add` (`library.ts:72`) and restores phase 1's four rules (FT14's phase 1 form), so the skill no longer offers them; flowcharts keep working, and an earlier phase 2 fence shows the `unknown-component` card. The readings, pictures and chunk changes may stay unused in that release (FR22).

## Phases

Each step leaves `npx nx test bundle-openui`, `npx nx test bundle-papercraft`, `npx nx test desktop` and `npx nx typecheck bundle-openui` passing. Steps continue phase 1's numbering.

| Step | Lands                                                                                                                                                                                                                                                                                                                                                                                                       | Tests                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 5    | The generalization, with no change in behavior: `TEXT_LIMITS`, `DIAGRAM_PARTS` with `Flowchart` only and `DiagramType` in `definitions.ts` (F13); `read.ts` and `readFlowchart` over it; `Element` and `isElement` moved to `read.ts`; the check's table with `Flowchart` only; the generic `Outline` and `flowchartOutline`; `useDrawn`; `DiagramFrame`, `FlowchartPicture` and `DiagramCanvas` over them. | FT1–FT17 unchanged (FT18) |
| 6    | `MindMap` and `Topic`: the layout graph's `algorithm`, the chunk's `mrtree` options and its checks (F18), FT8's `mrtree` assertion; `DIAGRAM_PARTS.MindMap`; definer, `readMindMap`, its check entry, the nested-diagram rule (F15), `mindMapOutline`, `sizeMindMap`, `mindMapGraph`, `mindmap-picture.tsx`, `MindMapView`, the library. The skill does not list it yet.                                    | FT8 extended, FT19–FT23   |
| 7    | `EntityDiagram`, `Entity`, `Field` and `Relation`: the layout graph's `markerSpacing`, `transposeRight` and end labels, the chunk's marker options, end labels, transposition and end-label check (F18); then the same parts as step 6 with `DIAGRAM_PARTS.EntityDiagram`, `entityGraph`'s reversal and the class and ER markers.                                                                           | FT24–FT27                 |
| 8    | `SequenceDiagram` and its five parts, with `DIAGRAM_PARTS.SequenceDiagram`, `misplaced` and `layoutSequence`.                                                                                                                                                                                                                                                                                               | FT28–FT32                 |
| 9    | F22's rules and the regenerated skill, the stories, the docs.                                                                                                                                                                                                                                                                                                                                               | FT14 extended, FT33–FT37  |

After each of steps 6, 7 and 8, the implementer runs `npx nx build bundle-openui` and records the growth of `dist/client/chunks/renderer.js` over phase 1's build, 5,635,773 bytes (G5, FR17).

Phase 2 ships with phase 1 when the user accepts both after [Acceptance](#acceptance) (UD13, U48).

## Files to change

| File                                                                                                  | Change                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `openui` `src/client/diagram/read.ts` (new)                                                           | F14: shared helpers                                                                                                       |
| `openui` `src/client/diagram/model.ts`                                                                | `readFlowchart` over `read.ts`; no change in behavior                                                                     |
| `openui` `src/client/diagram/definitions.ts`                                                          | F13: `TEXT_LIMITS`, `DIAGRAM_PARTS`, limits, enums, three definers                                                        |
| `openui` `src/client/diagram/sequence-model.ts`, `entity-model.ts`, `mindmap-model.ts` (new)          | F14                                                                                                                       |
| `openui` `src/client/diagram/check.ts`                                                                | F15: the table over `DIAGRAM_PARTS`; `isElement` from `read.ts`                                                           |
| `openui` `src/client/diagram/outline.tsx`                                                             | F16                                                                                                                       |
| `openui` `src/client/diagram/view.ts` (new), `flowchart.tsx`                                          | F17: `useDrawn`, `NOTES`; `FlowchartView` over them                                                                       |
| `openui` `src/client/diagram/sequence.tsx`, `entity.tsx`, `mindmap.tsx` (new)                         | F17: the three views                                                                                                      |
| `openui` `src/client/diagram/layout-types.ts`, `graph.ts`, `src/client/chunks/layout.ts`              | F18                                                                                                                       |
| `openui` `src/client/diagram/sequence-layout.ts` (new)                                                | F19                                                                                                                       |
| `openui` `src/client/diagram/canvas.tsx`                                                              | F20: `DiagramFrame`, `FlowchartPicture`, `DiagramCanvas` as their wrapper with phase 1's props, exported helpers          |
| `openui` `src/client/diagram/sequence-picture.tsx`, `entity-picture.tsx`, `mindmap-picture.tsx` (new) | F20                                                                                                                       |
| `openui` `src/client/diagram/measure.ts`                                                              | F21                                                                                                                       |
| `openui` `src/client/library.ts`                                                                      | F13: the twelve components                                                                                                |
| `openui` `src/host/skills/openui.md`                                                                  | regenerated (F22)                                                                                                         |
| `openui` `stories/sequence.stories.tsx`, `entity.stories.tsx`, `mindmap.stories.tsx` (new)            | each type streaming, drawn, at its limits, failed (a rejecting `layout`; not for sequences, which load no layout), static |
| `openui` `tests/client/support/random-graph.ts`                                                       | the three generators (Test plan)                                                                                          |
| `openui` `tests/client/skill-text.test.ts`                                                            | F22's rules, the twelve components, FT14's counts, FT33                                                                   |
| `openui` `tests/client-chunk.test.ts`                                                                 | FT8 also asserts `org.eclipse.elk.mrtree`                                                                                 |
| `openui` `tests/client/layout.test.ts`                                                                | FT19, FT24                                                                                                                |
| `openui` `tests/client/layout-fixtures.test.ts`                                                       | FT23, FT27                                                                                                                |
| `openui` `tests/client/mindmap-model.test.ts`, `entity-model.test.ts`, `sequence-model.test.ts` (new) | FT20, FT25, FT28                                                                                                          |
| `openui` `tests/client/mindmap.test.ts`, `entity.test.ts`, `sequence.test.ts` (new)                   | FT22 and FT37; FT26; FT31, FT32 and FT37                                                                                  |
| `openui` `tests/client/sequence-layout.test.ts` (new)                                                 | FT29                                                                                                                      |
| `openui` `tests/client/diagram-check.test.ts`                                                         | FT21, FT30                                                                                                                |
| `openui` `tests/client/diagram-drawing.test.ts`                                                       | FT34, FT35                                                                                                                |
| `openui` phase 1's other test files, `tests/client/flowchart.test.ts` among them                      | unchanged (FT18, FT36)                                                                                                    |
| `openui` `README.md`                                                                                  | the three types (Docs to update)                                                                                          |

No change to `manifest.json`, `package.json`, `src/contracts/`, `src/client/check.ts`, `renderer.ts`, `fence-context.ts`, `packages/bundle`, `packages/desktop` or `papercraft`.

## Test plan

Tests follow `.agents/skills/behavioral-testing/SKILL.md`, as phase 1's do. Rendering tests mount `ConversationFence` with a fake `layout` prop (`tests/client/support/fence.ts`), as FT15 does.

**Generators.** `tests/client/support/random-graph.ts` adds, with phase 1's Park–Miller draws (state starts at the seed; each draw `state = state * 16807 % 2147483647`, returns `state / 2147483647`):

```ts
export const randomEntityDiagram: (
  shape: { entities: number; relations: number },
  seed: number,
  notation: 'er' | 'class',
) => unknown;
export const randomMindMap: (
  shape: { topics: number; depth: number },
  seed: number,
  layout: 'right' | 'down',
) => unknown;
export const randomSequence: (
  shape: { participants: number; steps: number },
  seed: number,
) => unknown;
// and `…Program` for each, writing F22's form (branch statements for mind maps), for stories and A2.
```

- **Entities** (M9): entity `i` has id `e<i>`, name `Table <i>`, and `1 + floor(draw × 8)` fields; field `k` is named `f<k>_` followed by `floor(draw × 24)` letters `x`, has the type `TYPES[floor(draw × 5)]` of `text`, `int`, `uuid`, `numeric(12, 2)` and `timestamp with time zone`, and the key `pk` for the first field; under `class`, `floor(draw × 4)` methods `m<k>(): void`. Then `r` relations, each: `a = floor(draw × e)`; `b = a` when a draw is below 0.05 (a self-relation), else `b = floor(draw × e)`, repeats and opposite pairs kept; the label `refers` when a draw is below 0.3; `fromCount`, then `toCount`, each unset when a draw is below 0.2, else `COUNTS[floor(draw × 4)]`; under `class`, `kind` `RELATION_KINDS[floor(draw × 6)]`.
- **Mind maps** (M10): topic 0 is the root, `Center`; topic `i` (1 … t − 1) is a child of the topic at index `floor(draw × count)` among the earlier topics of depth below `d`, taken in index order (`count` their number), labelled `Topic <i>`.
- **Sequences** (M11): participant `i` is `p<i>`, labelled `Service <i>`. Until `s` steps exist (counted as Terms counts them), one draw `c` per round decides: if `c < 0.1`, fewer than 3 fragments are open and at least 3 steps remain, a fragment of kind `FRAGMENT_KINDS[floor(draw × 4)]` opens, with one section (two for `alt` and `par`) labelled `case <n>.<k>` (`n` the steps so far, `k` the section's index); else, if `c < 0.2`, a fragment is open and its current section holds a step, the fragment moves to its next section, or closes after its last; else, if `c < 0.3`, a note `note <j>` over `p<floor(draw × p)>`, also over `p<floor(draw × p)>` when a further draw is below 0.5 and that is another participant; else a message from `p<floor(draw × p)>` to `p<floor(draw × p)>` (a self-message when equal), with the text `call <k>`, or `call <k> with a longer payload description that wraps` for every seventh message, and the kind `reply` for every third. A new step goes into the open fragment's current section, else into `steps`. Fragments open at the end stay as written; each holds a step, because a fragment opens only with 3 steps left and a section ends only after a step.

### Step 5

- **FT18** (phase 1's tests, unchanged): FT1–FT17 pass with the generalization of step 5; `tests/client/diagram-drawing.test.ts` still draws through `DiagramCanvas`, whose props do not change (F20).

### Step 6

- **FT19** (`tests/client/layout.test.ts`): an `mrtree` graph of one root and three children, `down` and `right`: every key is in the result, children lie below (`down`) or right of (`right`) the root, and every edge has at least 2 points. `mrtree` with a group, with a node of two parents, and with a two-node edge loop each reject with `Invalid layout graph: the graph is not a tree`; `mrtree` with `markerSpacing` rejects with `Invalid layout graph: layered options on an mrtree graph`.
- **FT20** (`tests/client/mindmap-model.test.ts`): `readMindMap`, one case per F14 rule, the exact texts in order: a topic at level 9 (it and its subtopics not drawn, one finding); 301 topics (`cut.topics` 301, preorder kept); a 121-character label; a 30-character label in a path (shortened inside the quotes); no root; a foreign child entry (skipped); `layout` `"sideways"` (`right`, no finding).
- **FT21** (`tests/client/diagram-check.test.ts`): a `MindMap` with a 9-level topic gives one line on its statement, also when the topic sits in a branch statement; a `Topic` in a `Stack` gives `Topic draws only inside a MindMap.`; a `Node` inside a `MindMap`'s children gives `Node draws only inside a Flowchart.`; a `Flowchart` in a `Topic`'s `children` gives `Flowchart is not drawn inside a MindMap.` on the `Flowchart`'s statement and nothing for its nodes.
- **FT22** (`tests/client/mindmap.test.ts`, `ConversationFence`): a streaming fence cut inside the second branch shows `Mind map: <n> topics` and nested lists with the topics written so far, no `svg`; closed, with a fake `layout` that resolves: one `svg[role="img"]` labelled with the header, one shape per topic, one path per edge, the root's fill `group2`; `layout: "down"` labels the area `Tree, pan and zoom`. A rejecting `layout` shows `This diagram could not be drawn: boom`.
- **FT23** (`tests/client/layout-fixtures.test.ts`, G3 a): for every seed of the mind-map fixtures 30/3, 100/5 and 300/8, both layouts: no two topic boxes intersect; no edge segment crosses a topic other than its ends; deep-equal twice.

### Step 7

- **FT24** (`tests/client/layout.test.ts`): a `layered` graph with `markerSpacing` and `transposeRight` whose labelled edge has `tailLabel` and `headLabel`, `down` and `right`: the result has both end-label boxes, the tail label's centre nearer the route's first point than its last and the head label's the reverse; for `right`, the result is the transposed `down` layout of the swapped graph (FT24 lays both out and compares), also with no end label. With `markerSpacing`, a self-edge and an edge between adjacent layers have every end segment at least 18 px long. End labels with a group reject with `Invalid layout graph: end labels with groups`.
- **FT25** (`tests/client/entity-model.test.ts`): `readEntities`, one case per F14 rule, the exact texts in order: an id of 65 characters; a repeated entity; 61 entities; methods under `er` (dropped, no finding); a relation to an unknown entity, and one whose `from` and `to` are both unknown (`<missing>` is `from`); 121 relations; a self-relation and the same relation twice (both drawn, no finding); `kind: "inherits"` under `er` (`association`, no finding); a 121-character entity name, field type, method and relation label (one finding each); an empty entity name (the id drawn); out-of-schema values under `class` (`kind: "bogus"` reads `association`, `fromCount: "2"` and `key: "primary"` read unset, a numeric `type` reads unset, `notation: "uml"` reads `er`, `direction: "up"` reads `down`; no finding); no entities.
- **FT26** (`tests/client/entity.test.ts`, `ConversationFence`): under `er`, a closed two-entity diagram with `Relation("user", "order", "association", "places", "1", "*")`: the header band shows the names, the key column shows `PK`, the relation's path ends carry a one-bar marker at `user` and a circle-and-crow's-foot at `order`, the label plate shows `places`; the outline lists `users → orders 1 to *: places`, the SVG is labelled `ER diagram: 2 entities, 1 relation` and the area `ER diagram, pan and zoom`. Under `class`, `Relation("dog", "animal", "inherits", "", "*", "1")`: the `layout` fake receives the edge from the parent's key to the child's, with `tailLabel` sized for `1` and `headLabel` for `*` (swapped with the ends), and with `markerSpacing` and `transposeRight`; the drawn path ends with a hollow triangle at the parent; the outline lists `Dog → Animal (inherits) * to 1`; the area is `Class diagram, pan and zoom`; the six kinds draw the line and markers of F20's table.
- **FT27** (`tests/client/layout-fixtures.test.ts`, G3 a): for every seed of the entity fixtures 10/12, 30/50 and 60/120, `er` and `class`, both directions, read, sized with the estimate and laid out by the real chunk: no two entity boxes intersect; no relation segment crosses an entity other than its ends (shrunk by 2 px); no label, tail label or head label intersects an entity box; no two labels of any kind intersect; with F20's marker boxes at the ends that carry a marker, no end segment is shorter than its marker and no marker box intersects an entity other than its own end's; each fixture laid out twice is deep-equal. Tolerances, as M9's: two labels overlapping by at most 1 px and two marker boxes overlapping by at most 0.5 px are not defects; box overlaps allow 1e-6 px for floating point. Pairs of intersecting marker boxes, and marker boxes under another relation's end label, leaving out markers and labels of self-relations, are summed over seeds 1–5 per fixture set and asserted at most M9's counts (FR20): intersecting pairs `er` `down` 0/0/0, `er` `right` 0/10/22, `class` `down` 0/0/0, `class` `right` 0/0/3; markers under an end label `er` 0/0/0 both directions, `class` `down` 2/13/37, `class` `right` 9/48/129 (for 10/12, 30/50 and 60/120). A higher count stops step 7 and goes to the user.

### Step 8

- **FT28** (`tests/client/sequence-model.test.ts`): `readSequence`, one case per F14 rule, the exact texts in order: 21 participants; a repeated participant id; a `Section` directly in `steps` (`A Section in steps is not drawn: steps holds Message, Note and Fragment.`) and a `Message` directly in `sections` (`A Message in sections is not drawn: sections holds Section.`); a message to an unknown participant; a note with an empty `over` and one over an unknown id; 149 messages, then a fragment (number 150) holding 80 messages (230 valid steps: the fragment drawn with its first 50 messages, `cut.steps` 230); 199 messages, then a fragment (number 200) holding 3 messages (203 valid steps: the fragment not drawn, only the limit finding, `cut.steps` 203); an `alt` fragment whose sections hold only invalid messages (not drawn, one finding, no number); nested fragments three deep; a self-message; `kind: "bogus"` (`call`); a 121-character message text, note text, section label and participant label (one finding each); an empty participant label (the id drawn); no participants.
- **FT29** (`tests/client/sequence-layout.test.ts`, G3 a): for the sequence fixtures 3/12, 8/50 and 20/200, seeds 1–5, `layoutSequence` with the estimate: lifeline x strictly increases in participant order; every plate of a message between two lifelines lies between them; every self-message's plate lies right of its loop and left of the next lifeline; no two message plates or notes intersect; row tops strictly increase in step order; every fragment's box holds the boxes, plates and points of its steps, its nested fragments' boxes, its tab and its section labels, and spans every lifeline its messages and notes name; every box and point lies within 0 ≤ x ≤ width and 0 ≤ y ≤ height.
- **FT30** (`tests/client/diagram-check.test.ts`): a `Section` in a `Stack` gives `Section draws only inside a SequenceDiagram.`; a `SequenceDiagram` whose findings are 25 gives one fitted line, as FT12 asserts for flowcharts.
- **FT31** (`tests/client/sequence.test.ts`, G4): a streaming fence cut inside a nested `Section` shows `Sequence diagram: 3 participants, <n> steps` with the steps written so far, nested under their fragment and section; the body grows by its next chunk inside one synchronous `act` with no timer advanced, and the new step is in the outline when `act` returns.
- **FT32** (`tests/client/sequence.test.ts`, G5): a closed sequence fence with a `layout` fake that records calls draws one `svg[role="img"]`, one header and lifeline per participant, one arrow per message (dashed for `reply`), one note, the fragment's rectangle and tab with `alt` and both section labels, and the fake records no call. Static in an older revision: no toolbar.

### Step 9

- **FT14** (extended, `tests/client/skill-text.test.ts`): `defineSequenceBuiltins`, `defineEntityBuiltins` and `defineMindMapBuiltins` call `define` in F13's orders; the rules are OpenUI's 15 then 15 Doric rules (10 plus F22's 5); the generated text equals `src/host/skills/openui.md`; the text minus the text without any diagram components and rules is at most 4,000 characters (G6).
- **FT33** (`tests/client/skill-text.test.ts`): the generated skill prints `Section(label: string, steps: (Message | Note | Fragment)[])` and `Topic(label: string, children?: Topic[])`, not `any`.
- **FT34** (`tests/client/diagram-drawing.test.ts`): `sizeEntities` makes an entity at least as wide as its widest row and tall enough for its rows plus the header band; under `class`, a separator and the methods; `sizeMindMap` sizes a topic as a `round` node.
- **FT35** (`tests/client/diagram-drawing.test.ts`): the crow's-foot marker of each count has the parts F20 lists; the class markers' shapes and fills follow F20's table.
- **FT36** (`tests/client/flowchart.test.ts`, unchanged): the Flowchart's outline, picture, toolbar and area label are those of phase 1.
- **FT37** (A5, `tests/client/mindmap.test.ts` and `sequence.test.ts`): a three-level `MindMap` and a `Fragment` nested in a `Fragment` are drawn with every topic and step, and the check gives no line ([concept A5](../features/openui-diagrams.md#riskiest-assumptions)).

### Acceptance

Run by the implementer and the user before both phases ship, in the format of phase 1's [Acceptance](openui-diagrams.md#acceptance); none is an automated test.

- **A2 for the new engines.** A2 is the concept's riskiest assumption that ELK's layout fits a window's main thread ([concept A2](../features/openui-diagrams.md#riskiest-assumptions)); phase 1 checked it for flowcharts ([A2 Main thread and CSP](openui-diagrams.md#acceptance)). A packaged build, one main Thread. The agent is asked to repeat 25 fences verbatim: `randomEntityDiagramProgram` under `class` with `direction` `right` (end labels, transposed) for 30/50 and 60/120, `randomMindMapProgram` for 100/5 and 300/8, and `randomSequenceProgram` for 20/200, seeds 1–5 each. A DevTools Performance profile as in phase 1: the median time in `layout` per fixture; for 30/50, 100/5 and 20/200, the time from the fence's close to its drawn `svg` (G4, ≤ 500 ms once the chunk is loaded; a sequence loads no chunk); the longest main-thread task when the Thread is shown again; any CSP violation. Exit, as phase 1's: a median above 300 ms, a main-thread task above 300 ms, or any violation lowers UD12's limits or moves layout off the main thread, decided with the user.
- **G1, G2, G3 (b), A1.** The agent answers these 12 prompts, 3 runs each, in a main Thread, without other instruction:
  1. "Show the sequence of an OAuth authorization-code login between the browser, the app, the auth server and the API."
  2. "Draw a sequence diagram of placing an order: user, web app, order service, payment service and inventory, with what happens when payment fails."
  3. "Diagram how a client retries a request with exponential backoff against a flaky server, as a sequence."
  4. "Show the messages of a two-phase commit between a coordinator and three participants, including an abort."
  5. "Draw the ER diagram of a blog: users, posts, comments, tags and the posts–tags join table, with keys."
  6. "Show the database schema of an online shop as an ER diagram: customers, orders, order items, products and payments."
  7. "Draw a class diagram of a payment system with a PaymentMethod interface, card and bank-transfer implementations, and a Payment that owns its line items."
  8. "Show the classes of a simple game: an abstract Entity, Player and Enemy that extend it, a World that holds entities, and a Weapon the player uses."
  9. "Make a mind map for planning a product launch."
  10. "Mind-map the topics of an introductory machine learning course."
  11. "Show the org chart of a 30-person startup as a tree: CEO, CTO with engineering teams, COO with operations and sales."
  12. "Draw the folder structure of a typical Next.js project as a tree."

  G1 counts fences holding the component the prompt names (`SequenceDiagram` for 1–4, `EntityDiagram` with `notation` `er` for 5–6 and `class` for 7–8, `MindMap` with `layout` `right` for 9–10 and `down` for 11–12); G2 counts closed revisions with an empty error card; the user judges G3 (b) on the drawn diagrams. A1: the same prompts asking for Mermaid `sequenceDiagram`, `erDiagram`, `classDiagram` and `mindmap`, checked with Mermaid's parser outside Doric; if native G2 trails Mermaid's by more than 10 points, UD6 goes back to the user ([concept A1](../features/openui-diagrams.md#riskiest-assumptions)). A7: the user's G3 (b) judgment is compared with FT27, FT23 and FT29's measures; a judged defect the measures miss is added to them ([concept A7](../features/openui-diagrams.md#riskiest-assumptions)).

- **Patches (G2, FR16).** In the same Thread as each run: after 2, "Add a step where the inventory is reserved before payment."; after 7, "Add a Wallet payment method."; after 9, "Add a branch for partnerships with three topics." That gives 9 patch revisions. G2 counts those with an empty error card. The outline text of the earlier and the patched revision is compared: every part the prompt does not change is still drawn with the same text.
- **G5 size.** `npx nx build bundle-openui` after step 9: the growth of `dist/client/chunks/renderer.js` over 5,594,179 bytes, both phases together, target ≤ 100,000 bytes (G5); steps 6–8 record theirs (Phases, FR17).

## Measurements

All on 2026-11-06 in `/workspace/scratch/diag-p2`, a folder outside the repository, with Node 22 on Linux aarch64 and the repository's elkjs 0.11.1, lang-core, react-ui, React 19.2.8, happy-dom and zod. The scripts are not kept in the repository, as phase 1's were not; each entry says how to repeat it. FT23, FT27 and FT29 repeat M9–M11's checks in the tests; M8's parser behaviors are repeated by FT22 and FT31 where the drawing depends on them; M7's count is FT14's and its printed recursion FT33's; M12 and M13 informed decisions and are not tested.

- **M7 Skill growth and signatures.** The sixteen components defined with lang-core's `defineComponent` as F13 writes them, and `openuiLibrary.extend({ components: { add } }).prompt(…)` with `openuiPromptOptions`, `inlineMode`, `editMode` and `openuiAdditionalRules`, against the same call with no diagram components and rules. Phase 1's four with its four rules: +1,632, as phase 1 measured. All sixteen: signatures +2,261 (phase 1's 637, phase 2's 1,624); with F22's five rules (330, 534, 284, 249 and 185 characters, each printed after `- ` and before a line break): +3,858 in the prototype; as built, compared with commit HEAD: +3,847 (Flowchart signatures 626, phase 2 signatures 1,624, rules 1,597). Version 3's rules, with section statements and `down` limited to 15 topics (345 and 630 characters for the first two): +3,969. With `z.lazy` for recursion, `Section.steps` and `Topic.children` print `any`; with getters, `(Message | Note | Fragment)[]` and `Topic[]`.
- **M8 Parser and names.** `createParser(library.toJSONSchema(), library.root)` over react-ui's library plus the sixteen, on: a complete sequence with an `alt` holding a nested `loop` (no error; nested elements as written); the same cut inside the nested section (the diagram stays, with the completed steps); the same ending before `steps =` (the diagram stays with `steps: null`); the sequence with its sections as statements, version 3's form (no error; sections carry their `statementId`), cut before `s2 =` (the diagram stays, `s2` unresolved and left out of `sections`) and cut after `steps` (the fragment with `sections: []`); an ER and a class diagram (no error); a mind map written in branch statements (no error; branch topics carry their `statementId`, `b1`); the same cut before `b2 =` (the map stays, `b2` unresolved); the same ending after the `MindMap` line (`null-required`, the map dropped until `top =` begins); a `Topic`, a `Section` and a `Field` in a `Stack` (no error); a `Section` directly in `steps`, a `Message` directly in `sections`, a `Field` in `entities` and a `Node` in a topic's `children` (no error: lang-core does not check which part a list holds); a `Message` with `kind: "bogus"` (`type-mismatch` at close). None of the twelve names is among react-ui's 82 components.
- **M9 ELK on entity diagrams.** The entity generator of the [Test plan](#test-plan), sized by F21's rules with the estimate (the sizes FT27 uses); `layered` with phase 1's options and F18's marker options, `right` transposed; 5 seeds per fixture after one warm-up layout. Over 10/12, 30/50 and 60/120 under `er` and `class` in both directions (9, 26 and 43 self-relations and 5, 14 and 22 repeated or opposite pairs per fixture set under `er`): zero box overlaps, relation segments through a box, labels or end labels on a box, label overlaps, end segments shorter than their marker (F20's boxes) and markers on another entity; the same geometry twice; slowest 114 ms. Defects are counted with FT27's tolerances: label overlaps of at most 1 px and marker overlaps of at most 0.5 px are not defects, box overlaps allow 1e-6 px for floating point, and markers and labels on self-relations are left out of the marker counts. Intersecting marker pairs (sum over seeds 1–5): `er` `right` 0, 10 and 22; `class` `right` 0, 0 and 3; `down` 0, 0 and 0 under both notations. Markers under another relation's end label: `class` `down` 2, 13 and 37; `class` `right` 9, 48 and 129; `er` 0 (no end labels). These counts were re-measured on 2026-11-06 with the spec's options, including phase 1's `elk.hierarchyHandling` `INCLUDE_CHILDREN` (`chunks/layout.ts:201`), which the first measurement's script left out. The same fixtures with phase 1's options alone: up to 103 end segments shorter than their marker per set, besides 6–48 self-relation ends, and up to 330 (`down`) and 439 (`right`) markers under end labels at 60/120. `er` `right` laid out by ELK's own `RIGHT` gives the same counts as transposed. With version 2's generator (no self-relations or repeats, 30 × 18 px end labels on every relation), ELK's own `RIGHT` overlapped end labels in 249 pairs at 60/120 and 54 at 30/50, unchanged with `elk.spacing.edgeLabel`, `elk.spacing.labelLabel`, larger layer and edge spacing, or `elk.layered.edgeLabels.sideSelection` `ALWAYS_UP` or `SMART_DOWN`; transposed, none. Node size constraints (`elk.nodeSize.constraints` `PORTS` with `elk.spacing.portPort` 16 or 56) raised intersecting marker pairs to 33–428 and were dropped; `elk.spacing.edgeEdge` 16, 32 or 48 changed no count.
- **M10 ELK on mind maps.** The mind-map generator, boxes 60–160 × 30 px (root 120 × 34), `mrtree` with F18's options, 5 seeds. 30/3, 100/5 and 300/8 in `DOWN` and `RIGHT`: zero box overlaps and zero ELK edge segments through a box; the same geometry twice; slowest 94 ms. Straight lines between box sides, instead of ELK's routes, crossed boxes 15–55 times per 5 graphs in `RIGHT`, so the picture draws ELK's points. `layered` gave no defects either and is not needed (P8). Largest drawings over 5 seeds, `down` width and `right` height: 15/3 1,436 and 553 px; 30/3 3,018 and 1,082; 50/4 4,164 and 1,473; 100/5 7,216 and 2,531; 300/8 16,551 and 5,958 (`right` at most 1,355 px wide).
- **M11 Sequence layout.** A prototype of F19's rules with the estimate and the sequence generator, checked with FT29's assertions over 3/12, 8/50 and 20/200, seeds 1–5 (21, 43 and 163 notes; 15, 30 and 28 self-messages; 3, 26 and 81 fragments, 1, 20 and 64 of them nested): no failure; slowest layout 1.7 ms; largest drawing 2,842 × 11,432 px at 20/200. The same checks against version 2's rules fail: without the shift, a box lies left of x = 0 in every seed; with fragment edges taken from lifelines only, self-message plates and points fall outside their fragment (2–5 per set) and so do notes (4–21 per set).
- **M12 Tokens.** gpt-tokenizer's `o200k_base`, 5 seeds, for F23's tables. Mind maps from the mind-map generator with word-list labels, written in one statement and in branch statements; a patch adds one topic under each topic in turn and counts the statement it rewrites. Sequences from the sequence generator in the three forms; a patch adds one message to each list in proportion to its length and counts the statements it rewrites. Four hand-written sequences shaped like acceptance prompts 1–4 (an OAuth login; an order with an `alt` for a failed payment; a retry `loop` holding an `alt`; a two-phase commit with a `par` and an `alt`), inline and with section statements, with one message added at the top level and in each section.
- **M13 Outline cost.** An entity outline as F16 writes it, 60 entities of k members each, rendered with React 19 into happy-dom; for the last 50 chunks of a stream, one member more per render. Median and longest render per chunk: 480 members 1.9 and 7.5 ms; 1,800 members 4.5 and 8.3 ms; 6,000 members 15.6 and 38.0 ms; 18,000 members 52.9 and 119 ms. happy-dom does no layout or paint, so a browser takes longer. A `Field` costs 8 tokens (`Field("name1", "text")`) to 13 (`Field("customer_id_1", "uuid", "fk")`) in `o200k_base`.

## Alternatives considered

- **Phase 2 as version 6 of the phase 1 spec.** Rejected for the reason the header's "Why a separate document" gives.
- **`openui` 2.3.0 for phase 2.** Rejected: both phases ship in one commit and one release, so no 2.2.0 without phase 2 would ever be released (F24).
- **One reading for every type.** Rejected: the four models share id rules and label cutting, which `read.ts` shares, but not their structure (graph, ordered steps, tree); one model would need fields that are empty for three types out of four.
- **`z.lazy` for recursion.** Rejected: the prompt prints `any` for the lazy type (M7), which tells the agent nothing about what a section or a topic holds.
- **`steps` and `relations` required, as the concept wrote them.** Rejected for phase 1's reason (M1, M8): the diagram would leave the render until its last list starts.
- **ELK's own `RIGHT` for class diagrams with counts.** Rejected: end labels overlap at 30/50 and 60/120 under each option M9 lists.
- **Transposing only class diagrams that have a count written.** Rejected: writing the first count would switch the layout family and move every box. `er` diagrams, which carry no end labels, keep ELK's own `RIGHT`: transposing them measures the same counts (M9).
- **Line-end markers as ELK ports or node size constraints.** Rejected: `elk.nodeSize.constraints` `PORTS` multiplied intersecting markers (M9); F18's four spacing options remove short end segments and leave the counts FR20 gives.
- **A fallback from `down` to `right` above a width.** Rejected: it would override the layout the agent wrote without telling the reader, and `right` maps also pass the fitted area at 300 topics (5,958 px tall, M10).
- **A skill rule keeping `down` to small trees.** Rejected in version 4: it would treat one case of phase 1's accepted FR7 with an agent-side count, and its 15 characters leave G6 a 31-character margin (M7); FR13 is accepted as FR7 is.
- **A limit on an entity's fields and methods.** Rejected in version 2 at the Scope review: UD12 sets none; M13 measures the outline's cost of large members instead (FR21).
- **Counts as text next to the line ends without ELK's end labels.** Rejected: nothing would keep them off boxes and each other; ELK places them in `down`, and the transposed layout extends that to `right` (M9).
- **Crow's feet as text under `er`.** Rejected: ER notation draws them as markers; markers need no label space.
- **ELK `layered` for mind maps.** Not chosen: no fewer defects than `mrtree` (M10) and the concept chose `mrtree` (P8).
- **Straight lines between topic box sides.** Rejected: they cross boxes in `right` (M10); ELK's routes do not.
- **A sequence layout through ELK.** Rejected by the concept (P8): positions follow from the order alone, and sequences never load the chunk (G5).
- **A depth limit for nested fragments.** Not chosen: UD12 sets none, and 200 steps bound the nesting; each level insets its box (F19).
- **A mind map written in one statement.** Rejected: every patch would rewrite the whole map (M12, F23).
- **One statement per `Section`.** Rejected in version 4: on prompt-shaped sequences it saves about 100 tokens per patch and costs 5.3 % on every write (M12, F23).
- **A statement per sequence step.** Rejected: 30–35 % more tokens on every write, and each step's place kept in two statements (M12, F23).
- **Silent skipping of misplaced parts, as phase 1 does.** Rejected for a sequence's nested lists only: lang-core accepts a `Section` directly in `steps` without an error (M8), so the part would vanish without a line in the error card (F14).

## Risks

- **FR13 Large drawings in fitted and static fences.** A `down` tree of 30 topics is up to 3,018 px wide and one of 300 up to 16,551 px; a `right` map of 300 topics is up to 5,958 px tall; a 20/200 sequence is up to 2,842 × 11,432 px (M10, M11). The fit shrinks such a drawing below a readable size, and a static fence cannot pan (phase 1's [FR7](openui-diagrams.md#risks)). Mitigation: the latest fence pans and zooms; the limits (UD12). Accepted as phase 1 accepted FR7.
- **FR14 Transposition and ELK changes.** The transposed layout relies on swapping every size and coordinate; an ELK change in label placement for `DOWN` would show in both directions. Mitigation: FT24 compares the transposed result with the swapped `down` layout; FT27 checks every label.
- **FR15 Class direction conventions.** The drawing assumes `inherits` and `implements` point from child to parent and `composition` and `aggregation` from whole to part (F20); an agent that writes them the other way draws a wrong diagram that no check can catch. Mitigation: the fifth rule; G1 and G3 (b) on prompts 7–8.
- **FR16 Patch cost and silent changes.** A sequence patch rewrites all of `steps`: about 3,100 tokens at 20/200 (M12); they stream before the diagram shows the change, and a rewritten list can drop or alter steps the reader did not ask to change; no check compares revisions. Mitigation: branch statements limit a mind-map patch to one branch (F23); sequences of the prompts' size cost 122–200 tokens to patch (M12); the patch prompts compare outlines at acceptance; the reader sees the outline of the new revision. Accepted: comparing revisions at run time needs the previous program, which the check does not have.
- **FR17 Renderer chunk growth.** Phase 1's diagram sources (64,926 bytes of TypeScript in `src/client/diagram/`) grew `renderer.js` by 41,594 bytes, 0.64 bytes per source byte; G5 leaves phase 2 58,406 bytes. Phase 2's new and changed sources, estimated from their phase 1 counterparts (three readings 21 KB, three pictures 19 KB, the sequence layout 10 KB, definitions 6 KB, views 6 KB, outline, measuring, graphs and the check 9 KB), come to about 71 KB of source; the estimate of about 45 KB in the chunk was low: on a clean build phase 2 grew `renderer.js` by 58,600 bytes (5,635,773 → 5,694,373). Mitigation: the shared frame, outline, view and helpers (F16, F17, F20); the growth recorded after steps 6, 7 and 8 (Phases): when the growth over 5,635,773 bytes after a step, plus that step's own growth again for each type still to come, passes 58,406 bytes, the implementer stops and the user decides between accepting the size and moving the three pictures into a chunk of their own. **Triggered.** The step-wise figures recorded during implementation (step 6 → 5,646,270, step 7 → 5,668,203, step 8 → 5,693,348) were taken on stale builds and are not accurate; the clean build after step 9 measures 5,694,373 bytes, 58,600 over phase 1, 194 bytes past the 58,406 threshold. The coordinator did not stop: the overrun is 0.2 % of an unminified chunk, G5 is an acceptance target, and the user accepts both phases manually, so the user decides the size at acceptance.
- **FR18 Recursive schemas in TypeScript.** Getters on zod shapes need explicit return types where inference is circular; a mistake shows as a type error, not at run time. Mitigation: `npx nx typecheck bundle-openui` in every step; FT33 checks the printed signatures.
- **FR19 Unreported meaning loss.** Methods under `er` and class kinds under `er` are dropped without a finding (F14), to keep G2 from counting a harmless excess. An agent that meant a class diagram and wrote `er` gets an ER picture. Mitigation: G1 checks the notation on prompts 5–8.
- **FR20 Markers near other ends.** ELK does not know the markers' size. With F18's options, end segments are long enough and no marker lies on another entity, but where many relations meet one side of an entity, markers touch (`er` `right`: 22 pairs over five 60/120 diagrams) and a count label can cover another relation's marker (`class` `right`: 129 over five 60/120 diagrams, about one in five relations; `class` `down`: 37); `class` `right` 60/120 also has 3 intersecting marker pairs (M9). Mitigation: `down`, the default, has the fewest; FT27 holds the counts at M9's; A7 compares the user's judgment with them. Accepted.
- **FR21 Entities with many members.** Fields and methods are not limited (F14), and the outline lists every one at every streamed chunk: 15.6 ms per chunk at 6,000 members and 52.9 ms at 18,000 in happy-dom, more in a browser (M13); an entity is at most 1,947 px wide (F21) and as tall as its rows. Mitigation: the agent's output bounds a program (6,000 members are at least 48,000 tokens, M13); A2's profile includes the longest main-thread task. Accepted.
- **FR22 One release for both phases.** A phase 2 defect found after release is fixed forward or withdrawn by the 2.2.1 F24 describes; going back to 2.1.0 would also remove flowcharts. Mitigation: F24's partial rollback.
- **FR23 Security.** As phase 1: every text is a React text node; no prop becomes markup, a URL, a style or an attribute name; colors come only from `colors.ts`.
- **FR24 Scale.** Per diagram at most 20 participants and 200 steps, 60 entities with 120 relations (fields and methods not limited, FR21), 300 topics in 8 levels; one layout per diagram revision per mount; sequences none.
- Phase 1's FR1–FR12 ([phase 1 Risks](openui-diagrams.md#risks)) and the concept's R1–R12 ([concept Risks](../features/openui-diagrams.md#risks)) apply unchanged.

## Open questions

None needs the user before implementation. Recommended defaults this spec takes, each reversible in a later revision:

- **Version.** `openui` stays at 2.2.0 for both phases (F24).
- **Rules.** Phase 1's four flowchart rules are replaced by five rules for all four types; the flowchart guidance is kept in substance (F22).
- **Acceptance prompts.** The 12 prompts and 3 patch prompts above, by the format the user accepted for phase 1.

## Docs to update

Each is updated when step 9 lands, except the concept's Evolution entry, which this spec adds now.

- **[docs/features/openui-diagrams.md](../features/openui-diagrams.md)**: status `implemented` for both phases; "Current behavior and contracts" describes the three types, the end labels and the sequence layout; an Evolution entry for the commit.
- **[docs/features/generative-ui.md](../features/generative-ui.md)**: "Current behavior and contracts" names the four diagram types.
- **`bundles/features/openui/README.md`**: the "Diagrams" section (`README.md:88-105`) gains the three types, their limits and the sequence layout; "Entry and renderer chunk" notes that sequences never load the layout chunk.
- **[docs/designs/openui-diagrams.md](openui-diagrams.md)**: its Scope's line on phase 2 links this spec.
- **[GROUNDING.md](../../GROUNDING.md)**: the `openui` paragraph lists the four diagram types.
- **[docs/features/generative-ui.md](../features/generative-ui.md)**, also: the skill bullet describes the five diagram rules; the Specs line links this spec.
- **`bundles/features/openui/README.md`**, also: "What it provides" names the five diagram rules; "Design" links this spec and [docs/features/openui-diagrams.md](../features/openui-diagrams.md).

## Revisions

- **Version 1 (2026-11-06).** First version, from the concept (UD9–UD13, P8), phase 1 as built, and measurements M7–M12.
- **Version 2 (2026-11-06).** Answers the first Scope review. The 30-field and 30-method caps per `Entity` are dropped, with their two findings and FT25's case; UD12's limits are the only ones (F14, Risks, Alternatives, Open questions). `read.ts` also exports `isRecord` and `text`; labels and ids use phase 1's one label and id limit, so the new limit objects hold counts only and `cutLabel` takes no limit (F13, F14). The layout chunk's `mrtree` and its tree check land in step 6 with FT19, its end labels, transposition and end-label check in step 7 with FT24, so step 5 changes no behavior (Phases, Test plan, FR14). F18 states that its new checks keep the chunk's contract as phase 1's do. F19's timing note and FT29's logged time are removed.
- **Version 3 (2026-11-06).** Answers the Critique, Comprehension, Style and Structural reviews, with new measurements. F19's sequence layout is rewritten with its constants (`SEQUENCE_METRICS`): fragments are bounded by everything inside them, and the drawing is shifted so nothing lies left of the margin; a prototype passes FT29 on fixtures that now hold notes and long texts (M11). The entity generator now makes self-relations, repeats, mixed counts and varied rows; F18 adds `markers`, four ELK spacing options and transposition of every `right` entity diagram; F20 gives marker sizes; FT27 checks markers, and FR20 records the residual (M9). Sequences write each `Section` as a statement, and `down` trees stop at 15 topics, in F22's rules (3,969 characters, M7); F23's token tables measure patches by position (M12). Misplaced parts get a finding (F14, `misplaced`). F24 adds a partial rollback (FR22); FR13, FR16, FR17 and FR21 state measured sizes, costs and stop rules (M10, M12, M13). Terms, identifiers, A2's exits, the outline's count format and the generators are defined; tests are renumbered to follow the steps (step 5 FT18, step 6 FT19–FT23, step 7 FT24–FT27), and the test files table lists each file's tests.
- **Version 4 (2026-11-06).** Answers the Scope review of versions 2–3. `misplaced` covers only a sequence's nested lists (`steps`, `sections`) and lands in step 8; flat lists keep phase 1's rule (F14, FT25). The skill's `down`-to-15-topics clause is dropped and FR13 is accepted as phase 1's FR7. Sequence steps stay inline: on sequences shaped like acceptance prompts 1–4, section statements save about 100 tokens per patch and cost 5.3 % on every write (M12); the rules are version 2's again (3,858 characters in the prototype, 3,847 as built, M7). F13 adds `TEXT_LIMITS` and `DIAGRAM_PARTS`, read by `read.ts`, the check and `FLOWCHART_LIMITS`; `read.ts` exports `Element` and `isElement`, moved from the check. F18's flag is split into `markerSpacing` (entity graphs) and `transposeRight` (class graphs); `er` keeps ELK's own `RIGHT`. `SEQUENCE_METRICS` is module-private.
- **Version 5 (2026-11-06).** Answers the Readiness and Codebase reviews; no new measurement. F14 defines the sequence limit by numbering valid steps (a fragment numbered 200 is not drawn and keeps its number), quotes every id and text in findings, and states the mind map's count and invalid roots. F13 states every optional prop's default or unset value, types `DIAGRAM_PARTS` with `DiagramType`, and keeps `FLOWCHART_LIMITS`'s keys reading `TEXT_LIMITS`. F15 adds a finding for a diagram inside another diagram (step 6). F17 gives the views' props and leaves `height` out of their keys. F18 rejects layered options on an `mrtree` graph. F19 places a fragment's tab and section lines. F20 keeps `DiagramCanvas` with phase 1's props as the Flowchart's wrapper and types `FlowchartPicture` and the three new pictures. F21 states entity sizes, the key column and count label boxes, the sizes M9 used. FT18, FT25, FT26 and FT28 cover the new cases; FT8's `mrtree` assertion is step 6's. Steps 5–8 list the `definitions.ts` changes they need; build growth is recorded over phase 1's build (5,635,773 bytes). Terms point to papercraft's terms for program, statement, library and patch.
- **Implementation note (2026-11-06), no version change.** M9 re-measured with the spec's options: the first script left out phase 1's `elk.hierarchyHandling` `INCLUDE_CHILDREN`; with it, it reproduces the implementation's counts. M9, FR20 and FT27 give the new ceilings (`er` `right` intersecting marker pairs 22, was 25; markers under another relation's end label `class` `right` 129, was 121, and `class` `down` 37, was 23) and FT27's tolerances (1 px for labels, 0.5 px for markers, 1e-6 px for boxes; self-relations left out of the marker counts).
- **Implementation note (2026-11-06), no version change.** FR17's stop rule was triggered: phase 2 grew `renderer.js` by 58,600 bytes on a clean build (5,635,773 → 5,694,373), 194 bytes past 58,406; the step-wise figures recorded during implementation came from stale builds. The coordinator did not stop (0.2 % of an unminified chunk; G5 is an acceptance target; the user accepts both phases manually); the user decides the size at acceptance. The skill grows 3,847 characters over HEAD (M7, G6).
