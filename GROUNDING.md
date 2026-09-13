# Doric Grounding

Last reviewed: 2026-08-27

This is Doric's repository validity contract. Every agent working in this
repository must read it before non-trivial planning, reviewing, artifact
generation, architecture discussion, code editing, or workflow execution.

## Authority

Use this authority order:

1. System and runtime safety instructions.
2. Hard Constraints in this document.
3. Explicit user-approved constraints for the current task.
4. Current repository code, manifests, tests, and generated contracts.
5. Project agent instructions and task-specific skills.
6. The current task prompt.
7. Convention Parameters in this document.
8. Agent preference or local judgment.

Hard Constraints are gates. If a prompt conflicts with one, stop, cite the HC
ID, explain the conflict, and ask for user direction only when the constraint
allows a scoped human decision.

Convention Parameters are defaults. Follow them unless the task has a clear
reason to do otherwise, and record meaningful deviations where useful.

## Product Direction

Doric is a TypeScript-first agent-core project.

Current product work should focus on the agent runtime and its direct support
surfaces:

- prompt, message, and context handling;
- model/provider abstraction;
- tool definition, invocation, and result handling;
- agent loop control and structured events;
- error, cancellation, retry, and minimal state interfaces when justified.

The repository is not currently grounded in the former Rust CLI, daemon,
worker, lifecycle, TUI, slash-command, service, or multi-process architecture.
Those terms are out-of-scope markers unless the user explicitly expands the
product scope and current files support the change.

`agents/doric` is the Direct agent host. It exposes long-lived sandbox-backed
sessions through REST and Socket.IO, while the reusable agent loop remains in
`packages/agent`.

Repository-owned executable bundles live as individual Nx packages immediately
below `/bundles`; each bundle owns its package metadata, TypeScript build, and
isolated output below `agents/doric/dist/bundles/<name>`. `/bundles/core` owns
the built-in `edit`, `find`, `grep`, `terminal`, `tree`, `web`, and `write`
tools. `/bundles/git` owns the routable `git` tool plus focused skills for
cloning, commit preparation, conflict resolution, rebasing, remote
synchronization, and linked worktrees. The Git tool executes structured argv
directly without shell interpretation, forces non-interactive Git behavior,
bounds stdout and stderr, and exposes no dedicated credential input.
`packages/bundle` owns strict manifest validation and runtime loading.
Doric loads only immediate bundle directories, in lexical order, from its
built `dist/bundles` artifact. Manifests explicitly order every resource and
carry `alwaysAvailable` flags for tools and skills. Runtime tools are compiled
ESM `.js` default exports created through `packages/tool`; each export is an
inspectable `ToolFactory` that Doric binds to a sandbox in its composition
root. Runtime TypeScript is rejected. Skill `allowed-tools` references resolve
only within their declaring bundle. Bundle, skill, and tool-factory names are
globally unique, and duplicates are rejected rather than aliased or
deduplicated. `packages/bundle` publicly owns the JSON-Schema-compatible
`SkillSchema`, whose input is normalized into a canonical `SkillRecord` with
trimmed fields, stable unique `allowedTools`, and a recalculated `indexText`.
Doric includes every canonical skill body in its Direct system prompt in
bundle order. `packages/tool` publicly owns the
JSON-Schema-compatible `ToolDefinitionSchema`, whose runtime descriptors carry
both `inputSchema` and `outputSchema`, plus strict-output-compatible
`ToolMetadataSchema` and JSON value schemas used by structured consumers.
Executable tool factories expose Zod `input` and `output` schemas; handler
results are output-validated before execution resolves, with sanitized
`invalid_output` failures. Providers transmit only their supported tool fields
and use `inputSchema` as function parameters. Model-generated graph nodes use
tool metadata rather than executable tools or arbitrary tool input schemas.

`packages/okf` is the explicitly requested embeddable TypeScript library for
generating local Open Knowledge Format bundles. Its public `generate` API
accepts an injected provider/model configuration, a repository root, and an
optional output path. The default output is
`<root>/.agents/bundles/project`; every explicit output must remain below
`<root>/.agents/bundles`, including after resolving existing symbolic links or
junctions. The generator discovers a complete regular-file snapshot, respects
scoped target `.gitignore` rules, excludes symbolic links and binary content,
and processes every readable text file in configurable concurrent batches.
OKF derives type from the lowercase final extension and strictly validates TS,
TSX, JS, JSX, and JSON with the official Tree-sitter binding and grammars.
TS/JS concepts include deterministically sorted imports, resolved relative
targets, exports/re-exports, CommonJS relationships, and public members of
exported classes; JSON is syntax-validation-only, while unsupported extensions
remain ordinary text. Supported parsing uses a Tree-sitter buffer derived from
the JavaScript UTF-16 source length plus one, with a 32 KiB minimum rounded up
to the next power of two and bounded by the parser's unsigned 32-bit limit.
Parser buffer calculation, construction, language setup, and parsing failures
become a curated source-scoped `OKF_SOURCE_PARSE_FAILED` error at the `parse`
stage, while a parsed tree with syntax errors remains
`OKF_SOURCE_SYNTAX_INVALID` at the `syntax` stage. Each cache miss makes exactly three sequential
temperature-zero, tool-free plain-text completions using
`prompts/summarize/<target>/SYSTEM_PROMPT.md`,
`prompts/describe/<target>/SYSTEM_PROMPT.md`, and
`prompts/tags/<target>/SYSTEM_PROMPT.md`. The first request is
collision-safe Markdown containing Path, Type, an extracted Module Interface
when available, and the exact raw source with UTF-8 byte-length and
terminal-newline framing, so readable source is intentionally sent unchanged
to the caller-configured provider. Valid JSON uses a labeled `json` fence; all
other content uses `text`. Its non-empty trimmed Markdown analysis must not
begin with YAML frontmatter. The second and third calls each receive only that
analysis under `# Source Summary` in a collision-safe Markdown fence, without
path, type, interface, or raw content. The second prompt guides the model to
return one plain-text sentence of 1 to 240 characters ending in punctuation,
but runtime acceptance requires only the non-empty trimmed text guaranteed by
the completion boundary. Every such description is preserved without
normalization, truncation, repair, or restrictions on length, punctuation,
sentence count, or internal newlines. The third accepts
comma- or newline-separated plain text with an optional leading `Tags:`, a JSON
string array, an ordinary JSON object whose only own key is a `tags` string
array, or one complete matching Markdown fence containing one of those forms.
Plain items may have one whitespace-delimited bullet or decimal-list prefix
and one matching pair of single quotes, double quotes, or backticks. The prompt
guides the model toward concise tags, but runtime acceptance permits every
non-empty trimmed response. Recognized items preserve case, punctuation,
order, duplicates, and count after structural cleanup. Multiple non-empty
plain-text lines split by line; a single line splits by comma only with an
explicit `Tags:` label or when every comma candidate lacks sentence
punctuation. Malformed or unsupported JSON, non-string values, extra object
keys, mismatched or partial fences, content outside a fence, and recognized
forms with no remaining items fall back to the original trimmed response as
one tag. No call requests structured output or schema injection. All calls are
flagged as sensitive output, without
logging, response excerpts, or diagnostic/cause propagation. Generated
concepts persist the first result as analysis with the later description and
tags in deterministic YAML metadata plus Markdown. YAML preserves the complete
trimmed description, including internal newlines; the deterministic project
index folds whitespace only in its one-line tree entry and does not alter
concept metadata. The recipe includes normalized source identity, extension
type, sorted relationships,
and a recipe-aware SHA-256 covering source, relationships, parser/extractor,
concept-schema, YAML and plain-text validator versions (with
`plain-text-fields-v4` invalidating earlier description and tag-validation
caches), an explicit three-stage pipeline version, a versioned
next-power-of-two parser-buffer policy, all three exact prompts, provider ID,
model, and effort.
Cache hits make zero provider calls and parse
YAML for an exact hash match and still strictly parse supported source files.
Concepts mirror source paths without using reserved `index.md` or `log.md`
names, and one deterministic project index is written to the bundle root. The
public generator accepts an optional provider-neutral progress observer for
generation, per-file inspection, cache outcome, summary, description, and tags
stage start/completion, concept completion, index, and
final-summary events. Concurrent file events may interleave; each file is
identified only by its validated, normalized repository-relative source path,
and terminal file events include the synchronously updated processed count.
Host applications own stderr rendering; the root runner uses
`pino`/`pino-pretty`. Progress and failure logs exclude absolute root, output,
and filesystem paths; source bodies; prompts; provider/model identity;
responses; credentials; diagnostics; causes; thrown values; and
error names, messages, and stacks.
Known OKF operational failures use package-constructed, publicly inspectable
but non-constructible `OkfError` details: a fixed message, closed code and
stage, fixed hint, and, only for source-scoped stages, the validated normalized
repository-relative source. The exported `isOkfError` package-authenticity
guard is the sole trust check for logging; `instanceof`, prototypes, and field
shape are not authorization. Representative syntax,
parse, summary, description, and tags failures identify their safe stage and source
without retaining provider, parser, or filesystem diagnostics. Sanitized `AbortError`
values and progress-observer exceptions preserve their behavior and identity;
unknown failures may escape for hosts to replace with fixed output. Neither
the error nor host logging may include absolute paths, provider or filesystem
diagnostics, source bodies, prompts, responses, credentials, or caught
messages, names, stacks, codes, or causes.

`tools/okf` owns the provider-neutral, read-only `okf_search` tool for consuming
bundles below `<workspace>/.agents/bundles`. It performs bounded deterministic
lexical search over permissively parsed OKF frontmatter and Markdown bodies,
tolerates unknown producer fields and concept types, skips malformed concepts
and reserved index/log files, does not follow symbolic links, and does not
write files or access the network. The tool is a standalone package and is not
registered with a built-in workflow or agent composition by this scope.

`packages/victor` owns Node.js-compatible, process-local in-memory retrieval.
It exposes incremental lexical and vector indexes plus a read-only hybrid
search. The lexical index applies deterministic Unicode tokenization and BM25;
the vector index accepts caller-injected embedding generation and ranks by
cosine similarity. Both indexes store caller values through per-add text
transformation. Hybrid search queries its injected lexical and semantic sources
concurrently, fuses their bounded ranks with equal-weight reciprocal rank fusion
using a fixed rank constant of 60, deduplicates by a caller-provided canonical
key, and resolves fused-score ties by that key. It has no persistence or
provider integration.

`packages/state-machine` owns reusable, process-local typed transition
execution. A definition stores only its exhaustive handler map and infers its
available handler names from that map. Each run keeps its context, current
handler, and current state local and resolves with a finished, domain-failed,
or engine-error result. Every handler receives the same state object type but
explicitly supplies the next state to a transition. A transition accepts only
an available handler name and passes that handler a shallow copy of the
supplied state object. It owns no workflow policy, persistence, listeners,
recovery hooks, or external side effects.

`packages/mosaic` remains an independent library; it is
not part of the main Doric composition. It depends on `packages/state-machine`
and owns the goal-workflow policy: planning and revision, scheduling, skill retrieval and
reranking, and per-node skill/tool menu composition. Its public
factory accepts injected planning, localized-revision, execution, and reranker
providers, a logger, independent planning, localized revision, and execution
model profiles with explicit reasoning effort, plus reranker and embedder model
IDs without reasoning effort,
independent required positive safe-integer hint and execution candidate limits,
a selected-skill limit, a required non-negative integer
localized-revision limit, a required positive safe-integer per-node model-turn
limit, bundle skills and executable tools, and both retrievers. Run options may
carry a caller-owned UUID run ID and cancellation signal. The tool retriever remains
part of this composition contract, but
the bundle state does not query it or run an independent tool router. Model
graph output owns only `id`,
`goal`, `doneWhen`, `dependsOn`, and `deliver`; Mosaic deterministically assigns
array-order indices, pending status, empty runtime-owned `candidates`, `tools`,
`artifacts`, and `observations` arrays, plus null `bundle`, `outcome`, and
`termination` fields.
Each materialized graph also receives a runtime-owned safe non-negative integer
`revision`: P0 is `0`, P1 is `1`, and every localized revision increments it
contiguously. The model-facing planning schema does not expose this field. Plans
require non-empty nodes, IDs, goals, and criteria;
unique existing dependencies; acyclicity; and at least one terminal deliverable,
while every deliverable must be terminal. A node is independent only when its
completion cannot require revising choices made in another node. Joint
feasibility constraints remain in one node, upstream choices validate
downstream-invalidating constraints before completion, production owns final
semantic verification by default, and every semantic goal claim is explicit in
`doneWhen`. A routed node stores a complete
`SkillCandidate` trace with canonical name, exact finite reranker score,
contiguous one-based rank, and non-empty selector rationale for every accepted
or rejected candidate. Its non-null `OrderedBundle` stores the matching goal
ID, unique selected names in candidate order, and a non-empty global rationale.
`bundle: null` means the node has never passed routing; routed empty bundles are
non-null. Full skill definitions remain in the catalog and are resolved only
from bundle names when composing tools and the execution prompt.
Mosaic runs the fixed
`plan(P0) -> plan(P1) -> schedule -> bundle -> execution -> schedule -> delivery -> finish(MosaicResult)`
lifecycle, with `schedule -> revision -> schedule` for localized runtime
requests, over a run-local ordered graph snapshot array. Each graph's explicit
`revision`, rather than its array position or array length, is authoritative;
the history must be contiguous and ordered. The `plan` state rejects every
re-entry after P1. P0 is catalog-independent and P1 is exactly one body-aware
revision. For every P0 goal, P1 evaluates all required skills in configured
order followed by canonical, unique, non-required skills retrieved up to
`routing.maxHintCandidates`, which implements `K_hint`. Required skills neither
consume that limit nor depend on retrieval; when no optional catalog exists,
Mosaic skips retrieval but still extracts their goal-specific hints. Empty
extractions remain observable through `hint.result`, but only material hints
are passed to P1. Planning `retrieval.result` events contain only optional
skills actually recovered. The independent `routing.maxRetrievedCandidates`
implements `K_retrieve`; it is applied as a defensive post-filter bound over
canonical, unique, non-required skills.
`routing.maxSkills` is bounded only by `maxRetrievedCandidates`. Bundle routing uses the original request, current
goal and completion criteria, and only transitive-ancestor artifacts. It
retrieves a bounded routable-skill candidate set, reranks complete skill bodies,
validates one node-bound structured evaluation for every candidate plus a
global selection rationale, and locally normalizes the result by descending
relevance score with canonical-name tie-breaking. The exact provider scores are
preserved. The selected bundle is unique, bounded, may be empty, and remains
observable in that order on the node and its public result. No additional model
call is made. No-candidate routing and a zero selected-skill limit materialize
deterministic empty traces; the zero limit bypasses retrieval, reranking, and
selection. The exact node tool menu is the stable union of base tools and tools
declared by selected skills, with duplicate names removed by first occurrence.
Always-available skills participate in P1 hint extraction for every P0 goal but
remain excluded from routing, `bundle.skills`, and the selected-skill limit.
They are injected as universal execution instructions, may reference only base
tools, and do not expand the node tool menu.
Every model-authored structured object is validated locally against its complete
Zod contract before changing Mosaic state. P0, P1, each concurrent hint
candidate, bundle selection, and each localized revision create a fresh agent
with isolated empty in-memory message, executable-tool, and tool-call storages, preserve the authored
system prompt and Markdown user input, and terminate through the agent-owned
reserved structured-output tool using the operation's direct object schema
without sending a provider-native schema. Invalid submissions cannot
mutate Mosaic state, are retained only for provider replay and ephemeral
transactional repair, and may receive bounded diagnostic feedback for two
correction attempts. Concrete invalid primitive or missing leaves form a
baseline whose next submission can replace only the rejected paths; valid
fields remain unchanged and the composed object is revalidated. Malformed JSON,
root and collection errors, and cross-field refinements use whole-object
regeneration. Rejected candidates never enter Mosaic events, logs, or feedback;
the next invalid submission propagates `invalid_structured_output` through the
owning workflow state. The reserved
tool is never executed, registered in Mosaic, or materialized as an
`Observation`. Bundle selection preserves `sensitiveOutput`. Reranking remains
a direct provider operation, and provider or transport failures receive no
Mosaic infrastructure retry.
Execution creates one agent per ready node with isolated in-memory message and
tool-call storages plus executable tools resolved from the catalog. Each node makes one
`agent.complete` call with tools and a node-bound strict semantic-decision
schema plus the required Mosaic turn limit. One turn is one provider
invocation, including direct and terminal responses, tool-call responses, and
structured-output repair attempts. Tools requested on the final permitted turn
execute and their results are stored; exhaustion is raised before another
provider invocation. When a provider requires sequential tool calls, its
one-tool limit applies to each response rather than the node or task; another
tool may be called in a later response after observing the result. The executor
must continue while a reasonable corrective action remains: one failed command,
missing executable, or incomplete inspection is not sufficient for a
model-authored `blocked` decision. The model-facing decision owns only `status`, ordered criterion
evaluations, `result`, `revisionRequest`, and `reason`; each criterion owns its
zero-based index, satisfaction decision, model-authored evidence, and a unique
array of opaque observation IDs. The revision request owns only `goalId`,
`invalidatedAssumption`, and `requestedEffect`. Unknown legacy reference fields
are rejected. A model-authored `blocked` decision requires at least one
unsatisfied criterion; logical impossibility may still be established without
a local tool observation. The agent exposes that decision schema as its reserved terminal
tool, whether or not executable tools are present, rather than using
provider-native structured output. The terminal structured-output tool is
never an observation. Its collision-safe Markdown execution context contains
the original request, current goal and ordered `doneWhen` criteria, and compact
evidence for every completed transitive ancestor: criterion status, evidence,
observation IDs and counts, plus one producer-ordered ledger containing the ID,
producer, tool name, input, and output for each cited observation, and current
artifacts. Shared references are rendered once in ledger order;
uncited observations, call IDs, and unrelated branches are excluded. Selected
skill bodies remain in bundle order, followed by tool names and descriptions
without duplicated tool schemas. The executor directly inspects produced state
when possible rather than treating an ancestor declaration alone as semantic
proof. After a successful localized revision, affected nodes receive a short
handoff derived from graph history: the invalidated assumption, requested
effect, previously unsatisfied criteria, and relevant historical tool results.
Historical observation and provider call IDs are omitted; the handoff is
non-citable context, and the new execution must produce current observations
before relying on its claims or tool results. A post-revision `completed`
decision must cite at least one observation produced by that current node
execution; this additional evidence requirement does not apply to `blocked` or
`failed`. Historical results are eligible only when a previously unsatisfied
criterion cited their local observation; the handoff retains at most the five
most recent eligible results, compacts large inputs and outputs, and reports
the count omitted.

Each successfully serialized executable-tool return is first appended to the
node agent's isolated `ToolCallStorage` with a runtime-owned lowercase six-hex
handle derived from the first six hexadecimal characters of a fresh UUID. One
allocator is shared by every concurrent node in a run and reserves IDs from all
graph snapshots and the current wave. It retries collisions with fresh UUIDs
and raises an internal operational error after 32 consecutive collisions. The
same short ID appears in the Markdown tool-result message, awaited finished
event, node ledger, decisions, revisions, results, and delivery.
Evaluation-hook observations must supply the same canonical six-hex handles;
the shared allocator claims them before storage and rejects malformed,
duplicate, current-wave, or historical-snapshot collisions.
Mosaic materializes one ordered `Observation` per stored record on the producing
node before validating or storing the terminal semantic outcome. Every criterion
reference must be a unique opaque ID from that local ledger or from an observation
cited by a completed transitive ancestor and presented in the execution prompt.
Unknown, duplicate, cross-branch, descendant, retired-snapshot, and unpresented
IDs are rejected by the Agent's terminal `safeParse` before its normal two-repair
budget is exhausted, and the materialized-outcome schema repeats the same check
before outcome storage or artifact promotion for hooks and other bypass paths.
Each terminal parse resolves its authorized IDs dynamically from current local
tool-call records followed by causally projected active-graph observations, with
stable deduplication. An invalid-ID diagnostic never repeats the rejected value;
it ranks only authorized IDs by Levenshtein distance with causal-order ties,
shows at most ten IDs with explicit truncation, and directs the model to use an
empty list when none are authorized. An empty array is valid when proof needs no
tool observation. Complete observation objects remain
only on their producing nodes. `callId` is retained in an `Observation` for
correlation and is not exposed in execution or revision prompts. A completed decision is valid with zero, one, or multiple
observations. Completed nodes store their Markdown result as an inline
`text/markdown` artifact, append additional artifacts, and return the resolved wave to
scheduling. Model-authored `blocked` and `failed` decisions also resolve their
wave normally. When every node is terminal, `delivery` performs stable
topological assembly using original node-array position as its tie-breaker and
finishes with `MosaicResult`.
Before `completed`, the executor inspects available command exit, stderr,
timeout, and truncation signals. A later successful command requires a new
observation to prove that an earlier failed state was repaired. Required shell
steps use failure-preserving composition. Semantic `blocked` requires concrete
impossibility evidence, reasonable alternatives tried, and consideration of
`needs_revision`; lack of explicit confirmation is not by itself impossibility,
and operational failures remain distinct.
Artifacts use one strict public discriminated union: inline artifacts contain
`kind: 'inline'`, a normalized non-empty MIME type, and string data that may be
empty; reference artifacts contain `kind: 'reference'`, a normalized non-empty
MIME type, and a normalized non-empty opaque reference. Its provider-facing
JSON Schema represents the two strict variants with `anyOf`, avoiding the
unsupported `oneOf` keyword in terminal function parameters. The runtime preserves
artifact order through decisions, outcomes, graph snapshots, causal projection,
and delivery, and renders references as references rather than content. The
MOSAIC core only validates and transports opaque references; storage, resolution,
existence checks, persistence, and authorization policy remain out of scope.
Delivery does not make provider, model, skill, or tool calls. Its public parts
preserve Markdown exactly, expose copied additional artifacts and complete
runtime observations (including call IDs and inputs/outputs), and join part
Markdown only with `\n\n`. A `needs_revision` decision requires at least one observation,
must target the current node, and does not promote partial results: execution
stores its semantic request while every observation remains on the node, then
returns normally to scheduling. Turn exhaustion materializes every correlated
executable-tool observation already stored on the node, adds a data-free
runtime-owned `turn_limit` termination, marks the node blocked, promotes no result artifacts, and resolves
the wave normally. Provider, tool, schema, correlation, and state-machine
failures retain their original identity and reject the workflow. Execution
emits safe logs with node IDs, terminal statuses, and selected skill and tool names only, never prompts, decisions, outcomes,
reasons, tool payloads, or error details.
The run-local state contains only the ordered graph snapshots. Each node owns a
complete candidate trace, ordered `Observation[]`, `OrderedBundle | null`, `NodeOutcome | null`, and
`RuntimeTermination | null`. Outstanding
revision work is selected from node outcomes in deterministic node-wave order;
within each node, observations retain tool-result order. The localized planner receives every
queued observation as fenced tool name, input, and output evidence and never
receives `callId`. The successful local revision count and next revision are
derived from the active graph's explicit `revision`; retired IDs are the IDs found in older snapshots but absent from
the active graph. Each localized pass is owned by the dedicated `revision`
state, skips catalog hints, preserves completed and other non-pending nodes
exactly, permits changes only to the target and pending nodes, clears routing,
observations, outcome, termination, and partial results from a retained target, and prevents
retired ID reuse. A localized plan that changes none of the planner-owned
`id`, `goal`, `doneWhen`, `dependsOn`, or `deliver` fields in the revisable
region is rejected inside the structured-output boundary before a snapshot is
appended, so its repair does not consume the localized-revision limit. The prior graph snapshot retains its complete
`needs_revision` outcome and node observation ledger. Only successfully appended localized graphs count
against the configured limit; exhaustion preserves the outcome, adds a
runtime-owned `revision_limit` termination, and blocks the target without a
provider call. Descendants of blocked or failed dependencies become blocked
with direct dependency IDs, while independent branches continue. A completed
result includes `FinalDelivery`; blocked and failed results omit partial
delivery, with `failed` taking precedence. This behavior implements
MOSAIC 0.2 sections 4.8-4.10 and the `NodeContext`, `NodeDecision`,
`Observation`, runtime `NodeOutcome`, and `RevisionRequest` contracts in
Appendix A. The paper recommends a reserved terminal tool for provider-neutral
structured output while permitting other protocols that preserve complete
validation, atomicity, bounded feedback, and bounded recovery. Concurrent ready
waves, `Promise.allSettled`, the exact isolated-agent composition, explicit
criterion proof entries, and `text/markdown` artifact promotion are Doric
runtime choices.
Planning and revision append a graph, the last graph is active, and
scheduling mutates that graph when marking nodes ready. It succeeds for an
already-terminal graph and otherwise preserves the intentional missing-ready
domain failure when progress cannot continue.

Agent structured runs expose an optional awaited `onStructuredAttempt`
callback on `AgentRunOptions`. It receives only schema version, one-based
structured-submission attempt, runtime acceptance, whether bounded feedback
will be sent, and an optional safe validation diagnostic. It never receives
rejected arguments, model reasoning, thrown values, or raw causes. A callback
failure retains its identity and aborts both complete and stream runs before
further provider activity.

Agent runs validate an entire provider tool-call batch before any handler
executes. Invalid JSON, unknown tools, invalid payloads, and invalid terminal
submissions share a default two-repair budget, append `incomplete` tool results,
and may be observed through the safe `onToolCallRepair` counter callback.
Handler failures are never retried by this protocol repair path. Structured
runs require a terminal tool call at the runtime validation boundary and
disable parallel tool calls. They do not force provider `tool_choice`, because
reasoning models may support tools and reasoning without supporting forced tool
selection in the same request.

Every agent requires an injected `ToolCallStorage` in addition to message and
executable-tool storage. The package-owned in-memory implementation uses
`crypto.randomUUID` by default and accepts an injected ID factory for tests. It
rejects empty and within-storage duplicate IDs. Complete and stream runs share
one executable-tool path: validate, execute, serialize input and output, append
the record, store a short Markdown result envelope carrying the opaque ID, and
emit the finished lifecycle with that record. The awaited `onToolEvent` callback
receives started, finished, and failed events in both modes; streamed
`tool.finished` also exposes the record. Rejected calls, reserved terminal calls,
thrown handlers, and serialization failures create no record. Valid operational
failure values such as non-zero command exit codes remain ordinary records.

The public Mosaic result contract exposes copied node observations directly on
each `WorkflowNodeResult`, while delivery parts copy the same producing-node
ledger. `MosaicOptions.models`
separates planning, revision, and execution profiles and keeps reranking and
embedding as non-reasoning model IDs. Each
`MosaicAgent.prompt` additionally accepts run-local observation options with a
serial awaited observer, caller-supplied UUID run ID, cancellation signal, and
either `structure` capture, the default, or `io` capture. Version-three Mosaic
events carry one run ID and contiguous sequence; model events also carry the
configured provider ID. They cover lifecycle, planning, retrieval/reranking,
bundle/menu, scheduling waves,
node execution and tools, decisions and runtime observations, revision, and
delivery. Every delivered event is a detached deeply frozen copy. Observer
latency is excluded from reported durations; the first observer failure aborts
the run and suppresses later events without reverting effects already
executed. Structure capture contains only allowlisted identifiers, statuses,
counts, ranks, scores, and durations. IO capture may additionally contain
model-visible messages and tool definitions, model-emitted visible content,
and tool inputs and outputs; it excludes credentials, provider controls,
private reasoning, provider replay, encrypted reasoning content, usage
payloads, rejected structured candidates, diagnostics from caught failures,
and raw causes. Reserved terminal arguments and rejected structured-response
text are redacted while validated state remains available through graph,
decision, and outcome events. Existing Mosaic
logs remain allowlisted structural projections. Safe `tool.repair` events carry
only stage identity and attempt counters. `tool.finished` carries the same
`observationId` stored on its producing node.

`mosaic/evaluation` is the benchmark-only interception entrypoint over the
same validated engine. Its optional initial-plan, feedback-plan, skill-view,
retrieval, routing, menu, execution, and localized-revision hooks receive
detached readonly snapshots and may delegate through `next`. Hook results pass
the normal complete schemas and runtime invariants before state mutation. An
adapter with no hooks is behaviorally neutral. A feedback hook may return
`unchanged`; Mosaic then performs no hint or P1 provider call and materializes
revision 1 as a validated plan identical to P0.

The private benchmark applications are `benchmarks/direct` and
`benchmarks/mosaic`, executing `scripts/direct-skills-e2e` and
`scripts/mosaic-e2e` respectively. The previous benchmark code, composition
instruments, campaigns, and release machinery have been removed at the user's
request. Neither application depends on `packages/mosaic`.

`benchmarks/harness` owns shared local installation, catalog preparation, ACP
transport, task-container tools, and the host multi-model provider gateway.
Applications own separate result directories and Nx build/run targets; the
harness exposes build/test targets. Historical ignored results are preserved
and are not inputs to the new runners.

The private `scripts/direct-skill-planning` diagnostic lab compares request-
and P0-goal-level retrieval across direct generation and P0 revision. Judge
mode evaluates its five diagnostic pairs in both A/B orientations with two
independent models. Every planning, judging, embedding, and reranking operation
has at most five total attempts, with 5, 10, 20, and 30 seconds before attempts
two through five; an explicitly non-retryable provider failure exhausts after
its first recorded attempt without delay. Planning and judging omit
`temperature` so strict OpenRouter routing cannot reject a reasoning-model
endpoint for that unsupported optional control. The lab has no request pool or
leasing layer.
Exhausted judge orientations are retained as safe-code `partial` or `failed`
comparisons without cancelling other judge work, and the run ends as
`completed_with_failures`; exhausted planning or retrieval pauses the run. A
serialized atomic checkpoint writer preserves each completed case-round in
task order. Every failed attempt is also persisted before its delay and printed
as an allowlisted record containing operation and model identity, provider,
safe code, attempt state, next-delay milliseconds when applicable, optional
HTTP status and retryability, and applicable case, round, arm, retrieval,
goal-index, skill, pair, or orientation identifiers. The run boundary retains
the final safe failure record. These records exclude URLs, HTTP bodies and
headers, prompts, model inputs and outputs, diagnostics, messages, causes,
stacks, and credentials. This authored lab remains diagnostic and is not
confirmatory benchmark evidence.

The sibling private `scripts/skill-retrieval-gating` diagnostic keeps its
pipeline logic in one `index.mjs`, its output scoring, provider-usage
aggregation, run identity, and persistence in one `output.mjs`, its prompt text
in one `prompt.mjs`, its two-message
construction helper in one `utils.mjs`, and its Zod contracts in one
`schemas.mjs`. Each authored JSON case contains a name, objective, and an
exhaustive partition of the complete local catalog: `skills.expected` lists
required useful skills, `skills.useful` lists acceptable supplementary skills,
and `skills.noise` maps every remaining skill to `irrelevant`,
`no_operational_value`, or `conflicting`. These gold labels are used only to
evaluate the final bundle and never enter retrieval, gating, or planning. The
complete skill catalog is materialized below `cases/skills`; runtime execution
never downloads skills.
One provider generates P0 and independently retrieves lexical and semantic
rankings for every P0 goal using the case objective plus that goal. The BM25
lexical index searches each canonical skill name and complete body. Semantic
retrieval takes up to 20 vector candidates and removes those with cosine
similarity below the inclusive `0.3` minimum. Victor fuses the lexical and
retained semantic rankings through equal-weight reciprocal rank fusion, bounded
to 20 candidates, and the provider reranks up to the top 10 fused candidates.
Each goal trace preserves the lexical ranking, every pre-threshold vector score,
removed vector candidate, fused hybrid ranking, and structural reranker input
and output; catalog-bound names and positions identify reranker documents
without duplicating complete skill bodies. It evaluates every reranked goal-skill pair
independently as `keep | drop` with a reason using only the case objective, that
goal, and that complete skill body, then merges by skill name and keeps a skill
when at least one goal keeps it. P1 receives each complete kept body once.
Every logged pipeline action opts into a generic step-level retry with five
total attempts and exponential backoff. It waits 15, 30, 60, and 120 seconds
before attempts two through five, retries any thrown failure without consulting
provider retryability, rethrows the final failure unchanged, and logs only
structural attempt progress before each delay. Catalog indexing constructs a
fresh local index inside each attempt so a partially indexed attempt is
discarded rather than duplicated.
All cases execute concurrently. Per-case results report final-bundle recall,
noise rate, precision, and F1, plus noise removal, relevant retention, and
selection F1 from the unique recovered-skill union before gating to the selected
bundle after gating. Results also include counts, missing expected skills,
selected useful skills, selected noise classifications, and removed noise
classifications. The aggregate sums case counts and recomputes the same rates as
micro metrics. Recall uses only required expected skills; precision and relevant
retention accept both expected and supplementary useful skills. F1 combines
precision with required-skill recall; selection F1 combines precision with
relevant retention. A zero metric denominator produces zero. Before provider
use, the diagnostic creates a unique UUID directory below its ignored local
`output/` tree. Its manifest records the run status and timestamps, effective
configuration, Git commit and dirty-worktree flag, SHA-256 identities and
counts for the cases and skill catalog, a SHA-256 identity covering the
experiment sources and package metadata, and the Node.js environment; it
excludes credentials. The diagnostic renders all Pino output in the console
and appends it as JSON Lines to that run's `output.log`. A successful run also
writes complete per-case results, aggregate metrics, and aggregate provider
usage to `results.json`, then marks the manifest completed. Provider usage is
logged per successful call and aggregated into successful and failed manifests
with call coverage, tokens, search units, and provider-reported costs;
OpenRouter costs retain their `credits` unit. A failed run marks its manifest
failed. It has no
comparison judges, rounds, replay, checkpoints, similarity grouping,
redundancy adjudication, or historical evidence pipeline.

The sibling private `scripts/p0-planning-ablation` diagnostic is an oracle
final-synthesis test of whether exposing a frozen P0 draft harms planning over
a frozen copy of the same 30 cases and complete local skill catalog. Its
generation entrypoint accepts only three versioned fixtures. The baseline
catalog-independent fixture contains case name, objective, and nonempty goals
projected from run `89ba6c1e-470c-43ea-809b-a34a90f59540`, whose source
`results.json` SHA-256 is
`f904b241cc05264c281e017ebfb16cbe52af934c4d4c7bc6b62f71088f5b68db`.
Two strong skill-aware fixtures contain the frozen `withoutP0` plans from
completed oracle-bundle runs `aaae19f2-6f98-4539-8eda-e72bdf8b4f57` and
`d95fc9dd-42b8-4bfc-8358-7dcfae141198`; they are model-generated drafts, not
human gold plans. Runtime validation pins the selected filename, fixture
content hash, source run, and source-results hash, and requires a one-to-one
name and objective match with all 30 local cases before provider construction.
Normal generation does not regenerate P0 or read historical output
directories. Each fixture run is a separate robustness cell over the same
cases and cannot be pooled as independent observations.

Every generation cell also uses `p0-skill-aware-qwen.json` as its fixed
`withoutP0` control. Those arrays are frozen direct plans produced by
`qwen/qwen3.8-27b` from the same objectives, ordered gold skills, high effort,
direct system prompt, schema, and flags used by the treatment planner. Runtime
validates and persists the control filename, content hash, source run, and
source-results hash separately from the selected P0 fixture. The control is
loaded byte-identically for all three cells and no `withoutP0` provider call is
made. In the Qwen fixture cell, the exposed P0 and frozen control have identical
plan arrays.

Each case's fixed oracle bundle is the ordered, duplicate-free union of its
`expected` and `useful` skill names resolved to complete bodies in the local
catalog. Category labels are not sent to models. One fresh `withP0` planning
call per case uses the same planning model, effort, schema, flags, objective,
exact skill objects, bodies, order, direct-synthesis system prompt, and
objective-and-skills user prefix that produced the frozen control; it appends
only the selected frozen `P0 Draft`. The system prompt does not mention P0 or
revision. The objective is the sole scope and deliverable authority, and skills
are advisory. There is no fresh control generation, P0 generation, indexing,
embedding, lexical or vector
retrieval, hybrid fusion, reranking, semantic gate, bundle scoring, retrieval
configuration, or associated trace in this experiment.

One planning-independent primary judge initially compares the plans twice with
A/B positions exactly reversed. It receives only the objective, the same
ordered gold skill bodies, and the two options; it never receives P0, arm
identities, gold categories, historical results, traces, or experimental
metadata. Stable outcomes are `withoutP0`, `withP0`, `both`, or `neither`. An
initial orientation conflict triggers exactly one additional fresh balanced
A/B pair. The four semantic votes resolve only with a strict majority of at
least three; otherwise the case remains `inconsistent`. Byte-identical plan
arrays are classified as `both` after the required judge calls are still
recorded. The aggregate reports all outcomes, adjudication counts, the
Without-P0 preference rate over stable single-arm cases, and a predeclared
one-sided exact binomial test of whether that rate exceeds 0.5 at alpha 0.05. A
normal 30-case run has 30 fresh treatment calls and 60 initial judge calls;
each initially inconsistent case adds two `judge_adjudication` calls, for a
range of 90 to 150 successful calls. Retryable failures may cause additional
attempts before those operations resolve. Outputs retain UUID manifests,
separate selected-fixture, frozen-control, case, catalog, source, and package
identities, JSONL logs, per-operation usage, and complete case results with two
or four judgments. This diagnostic isolates the addition of the labeled draft
block under a shared neutral system prompt while holding the control fixed
across fixture cells. It does not establish downstream execution success,
separate draft semantics from added scaffold or context length, measure
treatment-generation stability, or generalize beyond the frozen P0 fixtures
and authored corpus; end-to-end confirmation remains a later stage. Reversed
judge orientations and conditional adjudication measure evaluation consistency
over each fixed plan pair.

The same diagnostic also retains a separate fixed historical cross-judge
rejudgment entrypoint. Its two pinned 30-case generation runs use the earlier
revision-framed treatment and its original one-sided With-P0 hypothesis; they
are not exposure-treatment cells and are not combined with new generation
runs. The versioned campaign fixture pins both runs by complete manifest and
results hashes, fixes the opposite judge for each run, and pins a
comparison-contract hash covering the byte-level judge system/user prompt,
structured choice contract, and provider flags. Before provider construction,
rejudge validates the pinned artifacts, source judge and planning lineage,
baseline P0 fixture/case/catalog identities, every objective, ordered gold
bundle, plan, orientation, winner mapping, outcome, and aggregate source
comparison. It then reuses the source run's exact inverted A/B positions and
makes only 60 judge calls under the `rejudge` usage operation; it never calls
either planner.

Rejudge outputs use a fresh UUID and retain the source artifact hashes, source
experiment-source hash, planning configuration, source and target judge
identities, campaign and protocol hashes, per-case frozen-plan hash, both
outcomes, and an outcome-transition matrix with agreement rates. Source
outputs remain unchanged. The two frozen plan batches are repeated generations
over the same 30 cases and are reported as separate robustness cells, not
pooled as 60 independent observations. Cross-judge agreement tests evaluator
robustness only and does not establish downstream execution quality.

Those two source runs predate the rejudge fixture, came from a dirty worktree,
and do not independently persist their comparison-contract hash. The campaign
therefore version-controls a reviewed historical attestation from each pinned
aggregate experiment-source hash to the contract. Runtime validates the pinned
source hash, attestation, and current contract fail-closed, but cannot derive
that historical association from the ignored run artifacts alone. Fresh
generation outputs include their mode, full current experiment-source hash,
and comparison-contract hash directly.

The private `scripts/mosaic-e2e` experiment exercises the proposed separate
acceptance-criteria and completion-judge architecture without the production
Mosaic state machine. It reuses the retrieval lab's local skill catalog and
public `llms`, `victor`, `agent`, `messages`, and `tool` APIs. A single request
passes through P0 goals, hybrid retrieval and reranking, a global keep/drop
gate, fresh P1 graph synthesis without P0, and a separate criteria call for each
node in topological order. Each criteria call receives the request, kept skill
bodies, full P1 graph, and current node and returns only that node's criteria.
Nodes execute sequentially in topological order with independent final
skill retrieval and selection, a real local terminal, and a fresh completion
judge after each submission. Criteria remain fixed; only all-satisfied judge
evaluations permit completion. Each executor receives the original request, the
complete goal list as Markdown bullets containing only goal text, and its current
node goal as the initial user message, with environment and selected skill bodies in its system
prompt alongside always-available instructions. Executor instructions scope work
and verification to the current goal, preserve earlier results and intermediate
artifacts, and request submission once that goal is verified. Each fresh judge receives only
the current node ID, goal, fixed criteria and candidate Markdown result, with
environment and always-available instructions in its system prompt. It receives
no original request, ancestor results, executor observation ledger or previous
judgments. Goals and criteria must therefore supply the stage's requirements.
Feedback continues the executor's conversation. A maximum of two submissions allows execution
feedback, while an unfinished node stops the experiment without automatic
replanning. Observations are runtime-owned; judgment references are validated
only against that fresh judge's own dynamically available tool records. Complete
executor and judge observations remain in traces and node results for external
analysis, without being forwarded to subsequent judges. One Docker-backed `sandbox.createSandbox`
session owns `/workspace` per run, with local inputs copied through the sandbox
file API, no host bind mounts, and networking disabled. Executor and judge share
that session; judge inspection-only behavior is prompt-based. The experiment loads
the compiled `core` bundle through `bundle.loadBundles`, binds all seven tool
factories to the session, and uses no experiment-owned terminal. Optional core
skills join the existing retrieval catalog; always-available core skills are
included as complete bodies in P1 planning context and injected into executor
and judge instructions. They remain excluded from retrieval and selection.
The manifest snapshots core skill
records and tool definitions. Core `web` requests run on the host and are not
restricted by the container's disabled networking. The runner exports
the workspace as a tar archive before disposing the container in `finally`, on
success or failure. Provider credentials stay in the host process. A self-contained CSV
case and a provider-free preparation command support initial validation. UUID
outputs preserve inputs, source hashes, intermediate traces, observations,
judgments and provider usage. Stage results are also written incrementally to
individual JSON files under each run's `stages/` directory, with sequential,
sanitized filenames that preserve repeated stages. These files retain the
trace entry's timestamp, stage, and data; all entries remain in `trace.jsonl`,
including inputs, usage, and tool observations that have no individual file.
This diagnostic neither changes the production
Mosaic contracts nor establishes comparative or statistical superiority.
Its default planning and skill-selection profile is `google/gemini-3.8-flash`
with high effort; execution independently uses `openai/gpt-6-astra` with low
effort. Criteria use `openai/gpt-5.6-sol` and completion judging uses
`openai/gpt-5.6-sol`, both with high effort.

The private `scripts/direct-skills-e2e` experiment uses P0 solely for per-goal
hybrid skill retrieval, reranking and per-goal keep/drop selection. Approved
skills are united by name in first-accepted order; approval by any goal retains
the skill, without a global gate. It then executes
the original request in one direct-agent conversation without exposing P0.
The executor receives selected skill bodies and always-available core instructions
in its system prompt, with the original request and environment in its user message,
all core tools and a host-bound `search_skills` tool. That tool reuses the run's
index, retrieves and reranks using the request plus current need, performs focused
keep/drop selection, and returns complete selected bodies without adding tools.
It has no P1, execution graph, generated criteria or completion judge. Completed
status is executor self-assessment. It follows mosaic-e2e's Docker isolation,
workspace export, UUID manifests, source hashes, JSONL traces, individual stage
files and usage capture. It has independent sources and output, the same bundled
CSV case, provider-free preparation, and no infrastructure retries or resume.

The shared private `scripts/e2e-scenarios/regional-close` case supplies original,
deterministically generated CSV inputs and one Markdown request to both E2E
runners through their existing request/workspace options. It exercises revision
selection, alias normalization, population recovery, national income quartiles,
weighted aggregation and complete exclusion auditing for 240 synthetic regions.
It adds no model tools, dependencies, container images or orchestration behavior.
Only its `inputs/` directory enters the agent workspace; the generator and frozen
expected outputs remain host-side. Its standard-library Python scorer reads the
exported workspace tar without extraction or agent-code execution, verifies
unchanged inputs and every required output against hash-bound expected facts,
and reports artifact success separately from runtime status and recorded cost.
The case has no established model failure rate and is not a SkillsBench
reproduction or an equal-compute comparison: Direct and MOSAIC retain their
existing different turn budgets. No paid execution is part of fixture generation
or scoring.

The same private scenario surface includes `inventory-replay` and
`warehouse-allocation`, using unchanged E2E runners and local-only synthetic
inputs. Inventory replay separates received-time revision selection from
effective-time replay, cancellations, FIFO issue/return provenance and atomic
transfers. Its gold artifacts derive from closed-form canonical lot allocations.
Warehouse allocation combines nested kit expansion with indivisible orders,
shared inventory, capacity, freight and carbon constraints, and an exact
lexicographic objective certified by exhaustive per-day enumeration. The two
scenarios share `scripts/e2e-scenarios/artifacts.py` for frozen identity checks,
read-only in-memory tar scoring, exact artifact coverage and runtime/cost reports.
Only scenario `inputs/` enter the sandbox; generators and expected artifacts stay
host-side. They add no agent tools, skills, runtime dependencies or paid runs and
establish no comparative success rate or equal-compute claim.

Local benchmarks pin BenchFlow 0.6.6 with transitive Python dependencies and
SkillsBench commit `b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af`.
The host requires Docker, Node, uv, and Git. Commands are `setup`, `list`,
`prepare`, `oracle`, and `run`; repeated `--task` selects a subset, defaulting
to `jax-computing-basics`. Model runs require `--yes-paid-run`. Provider-free
oracle runs execute the official solution and verifier in Docker.

Preparation builds a global catalog from all task skill packages, deduplicates
by name and complete resource hash, and copies resources into neutral paths.
Task-to-skill associations remain in a host-only manifest. Both arms apply their
existing retrieval and gating policies to this catalog plus optional core skills.
BenchFlow uses `no-skill` to disable task-specific gold skill injection. This is
a retrieval condition, not the official supplied-skills treatment or a
SkillComposer reproduction. Neutral paths remove adapter-added provenance;
the original skill content may itself contain contextual clues.

The standalone ACP bundle contains current flows and core tools, which execute
inside the BenchFlow-owned task container. Runtime injection accepts a provider,
environment description, cancellation signal, and record observer, preserving
diagnostic defaults. Cancellation reaches provider requests and command process
groups. ACP failures use generic errors without caught provider messages or
credentials. Trace events contain model-visible results, retrieval stages,
tool observations, and provider usage.

Benchmark runtime records are also sent through authenticated HTTP to the host's
`events.jsonl`, with a per-prompt run ID, agent, and increasing sequence number.
The host serializes appends and acknowledges only completed writes; publication
failure stops execution instead of silently losing evidence. Records include
the original request, ranked candidates and scores, gating decisions and reasons,
model-facing stage inputs, tool observations, usage, and final result. A missing
`run.finished` marks incomplete evidence, including abrupt container shutdown.
ACP status updates are progress only: BenchFlow's exported trajectory does not
preserve those records. Older runs without this journal cannot be reconstructed
from provider usage alone.

A host gateway serves a per-run archive pinned by SHA-256 and authenticated
completions, embeddings, and reranking requests restricted to configured models.
The OpenRouter key stays on the host; the agent receives an ephemeral credential
and removes credential-shaped environment variables before running tools.
The Node installation is separate from task toolchains and pinned by version
and architecture-specific SHA-256. Linux bridge networking may require an
explicit `--host-address`.

Artifacts record task selection, catalog identity, model/retrieval configuration,
agent hash, BenchFlow results, and raw provider usage. BenchFlow's single-model
LiteLLM usage tracking is disabled because current flows use multiple model
roles and retrieval providers via the host gateway. Missing provider cost is
unknown, never zero. These diagnostic runs establish neither a trusted cost
comparison nor a model success rate or equal-compute claim.

The benchmark gateway persists successful single-text float embeddings under
`benchmarks/harness/.cache/embeddings`, shared across tasks, retries and arms.
Cache identity includes a format version, provider endpoint and the entire
canonical request body, including exact input, model and dimensions. Only valid
finite vectors are stored, using atomic replacement. Missing or malformed cache
entries are recomputed; provider errors and other operations are never cached.
Hits return zero new tokens and cost and are marked `cache: "hit"` in gateway
usage; summaries count them separately from provider calls. This caches returned
vectors, not provider billing or reasoning. Concurrent cold misses across hosts
or processes may still issue duplicate requests. Changing a model alias upstream
does not invalidate existing vectors; deleting this cache forces recomputation.

`agents/doric` receives complete singleton configuration replacements through
`PUT /config`. It persists only provider IDs, HTTP(S) base URLs,
credential environment-variable names ending in `_API_KEY`, one
`models.execution` profile, and `execution.maxTurns`. Credential values remain
process environment inputs. Each session created by `POST /sessions`
captures the active configuration generation and an immutable JSONB snapshot;
later replacements affect only new sessions.

`packages/sandpool` owns process-local `SandboxSession` capacity, FIFO leasing,
background warming, bounded factory-attempt batches, replacement, and disposal.
It accepts an injected sandbox factory, depends only on the public `sandbox`
contract at runtime, never reuses released sessions, and has no
provider-specific creation policy or persistence. A batch rejects pending FIFO
acquisitions and heat waiters after `maxCreateAttempts` consecutive factory
failures; the default is three, and later demand starts a fresh batch so a
recovered provider can serve new work. Doric explicitly uses that three-attempt
limit, allowing its existing execution failure path to move affected sessions
from `queued` to `failed`. Its capacity option is `maxSandboxes`, and a lease
guards SSH access exactly as it guards other operations. `packages/sandbox` owns
the provider-neutral
`SandboxProvider` and `SandboxRuntime` boundary plus workspace, Git, file, diff,
network-policy normalization, and disposed-session behavior. Every sandbox has
explicit CPU, memory, and writable-layer disk resources; networking is disabled
by default, optional SSH is key-only and loopback-bound by default, and
effective egress requires IP-literal DNS. Doric explicitly provisions its agent
sandboxes from the multi-architecture `node:22-bookworm` image, which includes
Git, with the `1.1.1.1` DNS resolver so selected Git skills can reach public
remotes. `DORIC_SANDBOX_SSH=true` adds loopback-bound, dynamically allocated
user SSH access so a trusted same-host user can inspect the active session
sandbox. Native source runs default it off because provider SSH requires pinned
host assets; the Doric runtime image and Compose profiles default it on and
include those assets. Remote authentication remains runtime-provided and must
never be placed in model-visible tool arguments.

`packages/docker` and `packages/firecracker` depend inward on Sandbox and expose
providers. Docker is Doric's default; `DORIC_SANDBOX_PROVIDER=firecracker`
selects the direct Linux x86_64 Firecracker/KVM boundary. Firecracker has no
Docker dependency or socket access. Firecracker resolves anonymous public
Linux/amd64 OCI images directly with skopeo and umoci, converts validated
rootfs trees into immutable ext4 base disks, and retains them in a persistent
manifest-and-converter-keyed 20 GiB LRU cache. Each sandbox receives a separate
sparse ext4 writable OverlayFS disk and a jailed Firecracker 1.16.1 process,
private `/30` TAP network, provider-only management SSH channel, and optional
proxied user SSH access. Startup reconciliation and disposal own the jail,
process, disks, cache-use markers, TAP, nftables tables, proxy, and generated
keys transactionally.

Docker maps CPU, memory, and writable-layer disk resources to daemon limits.
It retries once without the writable-layer disk daemon limit only when the
local storage driver explicitly rejects that option, so that fallback leaves
the Docker writable layer unmetered; CPU and memory limits remain enforced.
Use a quota-capable Docker host when disk isolation is required. On Linux,
effective Docker egress requires a local Unix daemon,
host-network-namespace access, nftables `CAP_NET_ADMIN`, and provider-owned
rules keyed to the inspected container address. Linux Docker and Firecracker
block new sandbox-to-host traffic and protected public-egress destinations,
with only exact private CIDR/protocol/port exceptions. On native macOS and
Windows, the Docker provider deliberately skips custom firewall configuration
and uses Docker Desktop bridge/NAT egress directly for local development;
protected destinations that Linux blocks remain reachable there. Other host
platforms reject Docker egress. SSH is disabled by default, uses per-sandbox
Ed25519 user and host keys, is key-only, and binds to loopback unless an
advertised remote binding is explicit.

`agents/doric/.Dockerfile` reproducibly builds the agent and both built-in
bundles, pinned Firecracker and jailer, Linux 6.18 guest kernel, static BusyBox
and Dropbear bootstrap, initramfs, OCI/ext4 tooling, networking tools, and
OpenSSH client. Its Linux-only Compose profiles provide either the Docker
socket plus host-network firewall access or KVM/TUN/cgroup/state/cache access
without a Docker socket. The privileged Firecracker profile is a development
and e2e harness, not a production isolation boundary. Doric acquires one pool
lease when each persisted session is created and retains it across every
serialized prompt. It binds every bundle tool to that sandbox, propagates
cancellation through acquisition and active provider calls, and releases the
lease exactly once on termination, acquisition failure, or shutdown. Sessions
have no automatic expiry and therefore occupy capacity until explicitly
terminated.

Doric initializes an otherwise unconfigured Express application and attaches
a Socket.IO server to the same HTTP listener. The listener binds to
`DORIC_HOST` and `DORIC_PORT`, defaulting to `0.0.0.0:3000`; the Doric image
exposes port 3000. Its modular Express router exposes `GET /vms`, which returns
the IDs and selected provider names of runtimes successfully provisioned by
this Doric process and not yet successfully disposed. `GET /vms/:id/ssh`
returns the selected provider, owning live session ID, and complete
`SandboxSshAccess` only while that VM is leased to an active Direct session;
idle, releasing, and disposed VMs never expose access. The registry wraps the
provider at the composition boundary and the session service owns the
process-local lease association. `POST /sessions` accepts no prompt and includes a stable
session SSH subresource link while preserving asynchronous queued creation.
That subresource reports pending acquisition, returns the active VM and SSH
access, or reports unavailable or expired access after release. Private keys
remain ephemeral provider-managed sandbox state and HTTP response data;
provider disposal owns their key-file cleanup. They are never persisted in
Doric's database, logged, included in lists, or emitted through Socket.IO. SSH
HTTP responses prohibit caching. REST additionally owns `GET/PUT /config`,
session creation, cursor listing, detail, FIFO prompt acceptance through
`POST /sessions/:id/prompt`, ordered event replay with an optional exclusive
`afterSequence`, idempotent termination, and terminal-only deletion under
`/sessions`. A public session contains only its ID, state, captured config
revision, last sequence, timestamps, and an error code when applicable; list
and detail use the same representation. It never contains prompts, messages,
events, results, or SSH credentials. The `/mosaic` REST aliases do not exist.

Socket.IO namespace `/sessions` requires `sessionId` in the connection query
and accepts an optional `afterSequence`. It emits `session:snapshot` after full
or incremental durable playback, then `agent:event`, `session:updated`, and
`session:deleted` without a replay/live gap. Each delivered event is
`{ sessionId, promptId, sequence, type, event, createdAt }`. PostgreSQL is the
event source of truth: an event and the session's contiguous last sequence are
committed before live emission.

`agents/doric` owns its Prisma ORM 7 schema, generated client configuration,
and versioned PostgreSQL migrations. Production uses one adapter-pg Prisma
client per process and never applies migrations implicitly during HTTP startup.
PostgreSQL stores the singleton configuration, normalized provider/model rows,
generic session snapshots, persisted provider-ready message history, and
ordered JSONB events. The initial Direct migration creates that complete schema
from an empty database. Startup marks every
non-terminal session failed with the sanitized `process_interrupted` code;
events remain replayable and explicit terminal deletion cascades to events.
The local Compose surface pins PostgreSQL 18.4, mounts its PostgreSQL-18 volume
at `/var/lib/postgresql`, runs migrations as a one-shot dependency, and starts
either Doric sandbox profile only after the database is healthy and migrations
complete.
Doric startup emits safe structured `info` logs for its listener and sandbox
selection, PostgreSQL client initialization, sandbox limits, bundle resource
counts, active configuration revision and model profiles, session
reconciliation, mounted interfaces, and listener readiness. Startup failures
identify only the active bootstrap stage; they do not retain or emit database
or provider URLs, credential environment names or values, prompts, caught
diagnostics, causes, or thrown values.
Configuration and session routes remain unauthenticated on the existing
`0.0.0.0` listener. Provider base URLs and credential environment names are
intentionally configurable through the open PUT, so deployments must keep this
listener on an isolated trusted network. Agent events intentionally expose
reasoning, provider replay, tool input/output, results, and serialized errors;
configured credential values are redacted before persistence. Event bodies are
never written to operational logs.

Sandpool, each repository-owned LLM provider, and Victor require an injected
`pino.Logger` and create their own component child logger. They emit only safe,
structured `debug` operation logs: lifecycle and allowlisted counts/identifiers,
never prompts, model inputs or outputs, stored values, vectors, credentials,
URLs, headers, diagnostics, causes, or thrown values. A provider request with
`flags.sensitiveOutput` emits no provider operational logs. Composition roots
pass their existing logger to these dependencies; private OKF provider calls
use a disabled Pino logger.

Doric supports OpenAI, raw OpenRouter, unified OpenRouter, LM Studio native,
LM Studio OpenAI compatibility, and Codex as provider integrations. The unified
provider uses stable OpenRouter Chat Completions, a 15-minute live model
capability cache with stale-on-error fallback, and curated profiles for OpenAI,
Anthropic, Gemini, Gemma, DeepSeek, Kimi, Mistral, Qwen, Llama, xAI, GLM,
Cohere, and MiniMax. It maps tool choice and sequential controls, forwards only
already-compatible strict tool schemas, and preserves ordered opaque
`reasoning_details` for replay. It sends `parallel_tool_calls` only when the
live model catalog advertises that parameter; otherwise it omits the transport
control, reinforces sequential requests with a model-facing instruction, and
relies on the Agent's atomic tool-batch validation before execution. Direct
proxy compositions may provide one original upstream model identifier while
sending a different request model alias; those requests use the original's
curated profile and skip live capability discovery because an OpenAI-compatible
proxy model listing is not an OpenRouter capability catalog. Direct
tool-free schemas select advertised JSON Schema, JSON object mode, or a
deterministic schema prompt, then validate with the original Zod schema and
allow at most two correction attempts. Structured streams emit only after
buffered validation. Tools plus a direct provider schema and other
non-emulatable combinations fail explicitly before completion.
The opt-in paid unified-provider conformance runner reserves stdout for its
final JSON report, permits up to 1,024 output tokens per request, and emits Pino
progress to stderr. Failures identify the exact structured-output, tool-call,
or tool-replay stage and expose only the sanitized provider error fields already
retained by the LLM boundary. An empty non-sensitive structured response
diagnostic identifies its finish reason and available output/reasoning token
counts instead of returning an empty string.
LM Studio native
uses its native REST API at `http://localhost:1234` by default. LM Studio
OpenAI compatibility uses the OpenAI-compatible API at
`http://localhost:1234/v1` by default and sends structured-output requests
through chat completions `response_format` rather than OpenAI Responses
`text.format` when no tools are present. When tools and structured output are
both requested, LM Studio OpenAI compatibility rejects the request with a
provider error before sending HTTP because LM Studio rejects `tools` and
`response_format` together.
The OpenAI, OpenRouter, and LM Studio OpenAI-compatible integrations support
single-text embeddings through their OpenAI-compatible `/embeddings` endpoint
and text-document reranking through `/rerank` below the configured base URL.
Embedding requests may include optional positive-integer `dimensions`, which
the compatible providers forward unchanged to the endpoint.
Rerank requests carry a model, query, non-empty document list, and optional
positive `topN`. Successful embedding and rerank responses use explicit result
envelopes and preserve provider-reported usage when present. Usage may include
input, output, total, reasoning, cached-input, and cache-write token counts,
rerank search units, and normalized cost metadata with amount, optional unit,
and optional upstream amount. OpenRouter costs use the `credits` unit.
Successful rerank results expose each original document index and finite
relevance score. Codex and LM Studio native support neither embeddings nor
reranking.
`packages/llms` also exposes a generic OpenAI Responses-compatible factory with
caller-configured provider identity and base URL. Its `/responses`, `/models`,
`/embeddings`, and `/rerank` operations preserve that identity in metadata,
safe logs, stream events, and provider errors.
Provider configs may include an optional `baseUrl` string to
override provider endpoints that support it. Model configs may include an
optional provider-neutral `effort` value of `none`, `minimal`, `low`,
`medium`, `high`, or `xhigh`; legacy model `reasoning` remains supported as
the same effort alias. Config parsing rejects models that provide conflicting
`effort` and `reasoning` values. Provider requests may include top-level
`effort`, which takes precedence over legacy `flags.reasoning.effort`.
Provider requests may also control tool selection and parallel tool calls.
The OpenAI Responses adapter sends `store: false`, preserves every opaque
response output item for exact replay, forwards incomplete tool results, and
marks schemas strict only when their unmodified JSON Schema is already
strict-compatible. Replay and encrypted reasoning never enter provider
operational logs.
Provider requests may also set `flags.sensitiveOutput`; repository-owned
providers then suppress operational logs for the call and omit model-response
bodies, excerpts, diagnostics, and causes from error surfaces while preserving
the normal completion result.
Provider requests may set
`flags.includeStructuredSchemaOnSystemPrompt: true` together with `schema` to
append one deterministic, collision-safe Markdown system message containing
the converted JSON Schema. Authored system messages retain their order before
that generated message, followed by all non-system messages in their original
order. The flag is additive to provider-native structured-output fields;
omitting it, setting it to false, or using it without a schema leaves messages
unchanged. `flags.sensitiveOutput`, independently, controls repository-provider
diagnostic suppression for private calls.
Every `provider.complete` request with a schema resolves only after a JSON
response has been parsed and validated by that schema. Refusals, tool calls,
missing or invalid JSON, and schema-validation failures reject with
`invalid_structured_output`; successful structured completions always include
the validated `structured` value.
Every agent run with an output schema appends one collision-free strict
terminal tool derived from that schema, including when its caller-owned tool
storage has no executable definitions. The agent adds a deterministic system
instruction naming the terminal tool and never sends the native schema in its
provider requests. Ordinary executable tool calls continue through the
existing loop. The terminal tool call must be the only call in its response;
the agent parses and validates its JSON arguments with the original schema,
converts it to a tool-free structured finish, and never executes it or stores a
tool result for it. Missing, malformed, schema-invalid, duplicate, or mixed
terminal submissions are repairable. The agent stores each invalid response
for provider replay without executing any included call, then may make two
correction attempts after the initial invalid submission. A JSON candidate
whose Zod issues all point to concrete primitive or missing leaves is retained
ephemerally as a transactional baseline. The retry replaces only those paths,
ignores changes to previously valid paths, and fully validates the composition.
If composition fails, the whole retry follows normal validation and becomes a
new baseline only when all new issues are repairable leaves. Malformed JSON,
root or collection errors, and cross-field refinements clear the baseline and
regenerate the whole object. Ordinary tool turns, success, exhaustion, and run
termination also clear it. Each next request receives one transient system
correction naming the terminal tool, explaining the failure, stating when only
listed paths will be applied, and including at most ten normalized Zod issues
with their field path, issue kind, expected type when available, and safe
message; rejected arguments are never copied into the correction. The
retry budget is cumulative across the run, and ordinary tool turns neither
consume nor reset it. The third invalid submission throws the latest
`invalid_structured_output` `AgentErrorObject`, whose existing `diagnostic`
field contains the same safe validation details when available. This terminal
behavior applies equally to complete and stream agent runs. Streaming
buffers structured provider turns until terminal validation and suppresses all
provider events from an invalid turn. A successful transactional finish stores
and returns text serialized from the accepted composition while keeping raw
provider replay only in the provider replay field; no repair-specific public
event is added.
Agent runs may declare an optional positive safe-integer `maxTurns`; omission
keeps the loop unbounded. Invalid values fail with `TypeError` before message
storage or provider activity. The budget is checked immediately before every
provider invocation and counts ordinary responses, tool-call responses, and
structured-output repair attempts identically in `complete` and `stream`.
Tools from the last permitted turn execute and their results are stored before
the next invocation is rejected with `turn_limit_exceeded`. Exhausted streams
preserve emitted events and do not emit `agent.finished`.
OpenAI, Codex, and OpenRouter send resolved effort through `reasoning.effort`;
LM Studio OpenAI compatibility sends `reasoning_effort`; LM Studio native sends
its native `reasoning` value with `none` mapped to `off`, `minimal` to `low`,
and `xhigh` to `high`. The Codex provider uses the existing provider token
field for the Codex authorization value and derives Codex-compatible account
headers from that credential when available. OpenAI and LM Studio provider
configs may omit or blank the token for compatible local endpoints; in that
case the auth header is omitted. Codex and OpenRouter provider configs still
require configured tokens. Credential values must remain private runtime
inputs: do not persist, log, or echo resolved tokens.

The Codex OAuth profile is a package-owned default for the Codex browser
authorization flow. Host scripts should require only `CODEX_AUTHORIZATION` for
normal runtime use and let the OAuth package provide Codex's client id,
localhost callback route, connector scopes, and authorize-request parameters
unless an explicit override is needed for testing or a provider change. Codex
model requests use ChatGPT's Codex Responses backend with the ChatGPT access
token; they do not request the public OpenAI `api.responses.write` OAuth
scope. The ChatGPT Codex backend requires streaming requests with
`store: false` and non-empty instructions; non-streaming provider calls should
be fulfilled by consuming the streaming backend response. Codex requests must
not forward unsupported public Responses API controls such as `temperature`.

## Repository Shape

Doric is an Nx-managed TypeScript workspace with npm workspaces for
`agents/*`, `packages/*`, `tools/*`, `workflows/*`, `bundles/*`, and
`benchmarks/*`.

Use current manifests and source as the package inventory. Do not treat this
file as the source of truth for every package responsibility.

Durable boundaries:

- product packages live under `packages/*`;
- agent entry surfaces live under `agents/*`;
- standalone tool packages live under `tools/*`;
- workflow packages live under `workflows/*`;
- private evaluation instruments live under `benchmarks/*`;
- package APIs should be exported through public entrypoints;
- sibling packages should not deep-import another package's private source.

Before adding a package or boundary, identify the responsibility that makes it
deeper than a folder: a stable public contract, separate test boundary,
dependency-direction boundary, or proven second consumer.

## Runtime Boundaries

The target runtime is an embeddable TypeScript agent core usable from tests and
future host surfaces without coupling the agent to a specific CLI, daemon,
worker, UI, provider, or process model.

Keep provider integration behind TypeScript interfaces. Do not make one
provider the only runtime path unless the task is intentionally a narrow first
slice.

Keep tool behavior behind explicit, typed, testable interfaces. Do not add host
command execution, network access, filesystem mutation, credential handling,
persistence, or session behavior without explicit scope and validation.

Credentials and secrets must not be persisted, printed, logged, or committed.
Prefer dependency injection and explicit configuration objects for sensitive
runtime inputs.

Doric Direct session replay is durable in PostgreSQL. Sessions transition from
`queued` to `ready` after sandbox acquisition; each FIFO prompt transitions
`ready -> running -> ready`; termination uses `cancelling -> cancelled`; and
acquisition or reconciliation failures use `failed`. A fresh Agent per prompt
receives a fresh tool-call store, all sandbox-bound tools, the deterministic
all-skills system prompt, and `createMessageStorage(...)` initialized from the
exact persisted provider-ready history. Success and failure both persist the
resulting complete or partial history. Prompt failures return the session to
`ready`; acquisition failure is terminal. Doric adds `prompt.accepted`,
`agent.failed`, and `agent.cancelled` events around the Agent stream.

Arbitrary Agent event values are converted to JSON without dropping reasoning,
replay, tool payloads/results, errors, or defined stacks, causes, and own error
properties. Undefined object properties are omitted. Undefined array entries,
cycles, and other non-JSON values receive explicit markers, and configured
credential values are redacted. One process-local map owns only live leases,
FIFO prompts, abort controllers, and Socket.IO subscribers. It is not the
replay source of truth, does not resume accepted or queued prompts after
restart, and requires no distributed Socket.IO adapter because Doric currently
supports one host instance.

## Hard Constraints

### HC-001 Grounding Is Mandatory Context

Agents must read this document before non-trivial planning, reviewing,
artifact generation, architecture discussion, code editing, or workflow
execution.

Enforcement: if this document cannot be read, stop and report that the
repository grounding contract cannot be satisfied.

### HC-002 Current Repository State Is Authoritative

Current code, manifests, tests, and generated contracts beat memory,
assumptions, stale documentation, older summaries, and generic model knowledge.

Enforcement: verify current files before making architecture claims or changing
architecture-relevant behavior. Mark uncertain or future behavior as uncertain.

### HC-003 Keep Scope To The TypeScript Agent

New product work belongs in the TypeScript agent core unless the user
explicitly expands the scope.

Enforcement: do not add or design CLI, daemon, worker, lifecycle service, TUI,
slash-command, Rust product packages, or multi-process behavior without
explicit user approval for that scope.

### HC-004 Respect Minimal Boundaries

Do not add package splits, host/runtime boundaries, provider coupling, tool
privileges, persistence layers, or process orchestration before they are needed
by the agent core.

Enforcement: inspect current manifests and source before changing package
layout, public APIs, provider composition, tool registration, event streaming,
session persistence, config schema, or runtime behavior.

### HC-005 Preserve Unrelated Worktree Changes

Do not revert, overwrite, delete, stage, or commit unrelated user, maintainer,
or sub-agent changes.

Enforcement: inspect status before edits and commits. Keep write scope small.
Use destructive recovery only with explicit user approval and verified target
paths.

### HC-006 Validate Before Claiming Completion

Do not claim code, docs, workflows, or generated artifacts are complete or
working without appropriate evidence.

Enforcement: run relevant checks or state clearly why they could not be run and
what risk remains.

### HC-007 Protect Sensitive And Boundary Surfaces

Do not weaken security, privacy, permission, sandbox, command-execution,
network, authentication, secret-storage, config, or session boundaries without
explicit approval and validation.

Enforcement: stop for review before expanding command execution, network
access, credential handling, repository mutation, or persisted config/session
behavior.

### HC-008 Generated, Vendored, Lock, And Build Artifacts Need Provenance

Do not casually hand-edit generated contracts, vendored code, lockfiles,
schemas, or build outputs.

Enforcement: use the repository-approved generation, formatting, or validation
path when one exists, and explain why the artifact changed.

### HC-009 Human Gates Must Be Explicit

When scope, product tradeoffs, safety exceptions, destructive actions, missing
approval, or validation substitutions require human judgment, ask the user and
record the answer where useful.

Enforcement: do not treat silence, model confidence, or relative ranking as
user approval.

### HC-010 Keep Completion And Stream Inputs Human-Readable

Newly written or materially revised user-message inputs passed to model
`complete` or `stream` calls must not use raw or serialized JSON objects or
arrays as their outer prompt envelope.

Enforcement: write the outer prompt as simple, direct, unambiguous,
evidence-grounded Markdown. Literal JSON source material is allowed only in a
labeled fenced `json` block within that Markdown. This constraint does not
apply to provider transports, JSON-RPC, configuration, storage or persistence,
tools or tool payloads, schemas, or other non-prompt JSON.

## Convention Parameters

| ID     | Convention                                     | Default                                                                    | Deviation rule                                                            |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| CP-001 | Prefer the agent-only direction.               | Keep product work focused on the TypeScript agent core.                    | Explain why the task needs a larger product surface.                      |
| CP-002 | Prefer narrow, evidence-backed changes.        | Edit only files needed for the task and validate the touched behavior.     | Explain why a broader change is required.                                 |
| CP-003 | Prefer TypeScript and Nx-native commands.      | Use configured TypeScript, Nx, and formatter commands before substitutes.  | Explain tool absence, sandbox limits, or why a fallback proves the claim. |
| CP-004 | Prefer small interfaces over early frameworks. | Add minimal TypeScript contracts that can be tested directly.              | Explain why a larger abstraction is justified now.                        |
| CP-005 | Prefer progressive discovery.                  | Read only the grounding, instructions, manifests, and source needed.       | Broaden search when the task crosses boundaries or evidence is missing.   |
| CP-006 | Prefer durable provenance.                     | Name changed files, validation commands, decisions, and generated outputs. | Explain why provenance cannot be recorded.                                |
| CP-007 | Prefer implementation over chat-only advice.   | Land requested repository deliverables in files and verify them.           | Explain any blocker that prevents file changes.                           |
| CP-008 | Prefer Nx-managed package boundaries.          | Use Nx-visible workspace packages and public package entrypoints.          | Explain why a folder, manual scaffold, or direct source import is safer.  |
| CP-009 | Author model prompts for people first.         | Use simple, direct, unambiguous, evidence-grounded Markdown.               | Explain why another prompt format is necessary.                           |
