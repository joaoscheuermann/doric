# Doric Grounding

Last reviewed: 2026-09-30

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
Projects and independent chat Threads through REST and Socket.IO, while the
reusable agent loop remains in `packages/agent`.

`app/doric` is the Electron desktop application. Its sandboxed, context-isolated
main process is paired with the React renderer in `app/doric-renderer`; the
renderer owns the Tailwind CSS and shadcn/ui surface, using Radix primitives.
The main process alone communicates with Doric HTTP and Socket.IO at
`127.0.0.1:3000` and exposes only semantic Project, Thread, and configuration
operations, one event subscription per watched Thread, one selected-Project tree
subscription, one Thread history snapshot read, and connection status through a
preload IPC boundary. The status and Project namespaces share one process-long
Socket.IO Manager and Engine.IO connection, while each watched Thread is given a
Manager and connection of its own, so that Thread's subscription lives and dies
with its watch. The renderer keeps the Threads it has read for each Project, so
every open Project row renders its own subtree while live updates continue to
follow the selected Project alone.
The macOS workspace window retains always-visible native traffic lights over a
renderer-owned draggable title bar. Splash, native theme, and renderer default
to dark before React starts. The compact, resizable shadcn sidebar lists named
Projects and recursive Threads, supports inline create and rename, marks each
Project with a color the host assigns from a fixed palette when the Project is
created, and shows that color with a chevron for the row's open state. Rows keep
their own open state: opening one leaves the others exactly as they were and the
selection never closes a row, so a Project's Threads stay on screen while another
Project is opened or selected. Projects start closed; Threads start open over
their children. The sidebar exposes context actions
for create, color, lifecycle-aware delete, and copying Thread IDs.
Creation starts as a focused local draft: an empty submission stays in place,
while blur discards it without an API call. The draft row wears the mark the
entity will wear — the Project's color mark, empty until the host assigns it,
and a Thread's message icon, or the Git or GitHub icon once the host marks the
Thread's working directory as a repository — never a generic file icon.
Selecting a Thread opens its durable
event-derived conversation; the header names it. The app keeps a best-effort
local snapshot of each Thread's durable event log in the Electron main process:
a Thread's conversation renders instantly from that snapshot when it opens, then
reconciles through the subscription cursor and rewind markers. The conversation surface is, for now, deliberately bare: the rendering of it is
being rebuilt by hand. The renderer's Thread chat store is the only reader of the durable event
stream: it keeps every Thread the reader has opened subscribed on a connection of
its own, accumulates each Thread's events into that Thread's one ordered log,
projects each log into turns, and hands a surface one Thread's record, log, turns
and send and rewind operations — while the surface itself is a plain input, a
submit button and that log rendered verbatim as JSON, with no styling.
`threads.prompt` carries a new prompt and `threads.rewind` replaces a past one.
PostgreSQL Thread events remain the sole conversation-history source. Because that
rendering is being rebuilt, nothing here promises a shape yet for prose, reasoning,
tool calls, delegated input or comments. The packaged CSP permits fonts from `self`
only, and the faces vendored under `src/assets/fonts` are the only ones the
renderer wears: Noto Sans for the app's own surfaces, and IBM Plex Mono for the
conversation body alone. The sidebar
tree follows the selected Project's live
subscription, so a
Thread created by an agent appears without a manual refresh. The selected Thread
persists locally across app
restarts. One
full-height resize handle owns the sidebar boundary across header and content
and disappears when the sidebar closes; it draws no grip of its own. A segmented
footer shares that geometry: the sidebar side shows the Electron main process's
Socket.IO connection status, while the content side carries the execution picker
— the model a prompt is sent to, whether it thinks, and how hard — beside the
settings trigger. The right-hand panel footer names the selected Thread's working
directory with the host's Git line beside that path: the branch, its ahead/behind
counts, whether the worktree is dirty, and any Git operation in progress. The header
names the selected Thread as a breadcrumb of its
Project and the chain of Threads above it, and every part but the last selects
what it names.

A Project-scoped sandbox surface sits in a resizable right-hand panel that starts
open, and whose collapsed state is a narrow rail carrying its own toggle, so the
one control that expands and collapses the panel stays at the window's right
corner and never duplicates the sidebar's own toggle. It reads the selected
Project's one sandbox, but roots its tree at the selected Thread's working
directory rather than at the workspace root, so selecting another Thread
re-roots what it shows while the sandbox it reads stays the Project's, and it
only reads: a Files tab shows that working directory's whole directory tree,
read in one request, and a Changes tab shows every Git repository the workspace
tree holds, each
repository's root as a sticky header over that repository's own changed or
untracked files — one row and one status badge each — and the repository's own
diff. The tabs sit in the
panel's header, in place of a title, and its footer carries the editable working
directory and Git status, without a manual refresh button.
Selecting a file opens a resizable division between the
conversation and sandbox panel. This division keeps multiple tabs per Thread,
mixing files and agent terminals; opening the same item selects its existing
tab, and closing the last tab removes the division. A file tab's footer states
the chain the file was reached through, a chain too
deep for that row collapsing its middle behind one trigger, and whose text is
rendered read-only by the Monaco editor
bundled with the editor worker alone. Because the whole tree arrives in one
read, expanding a directory reads nothing and is pure view state; only a file's
content is read on demand, and the diff only when the Changes tab is shown. The
sandbox belongs to the Project and may not be usable at all: a queued,
failed or terminated Project explains itself — with the host's own retry hint
when the lease is pending — instead of erroring. One renderer coordinator
revalidates a Project's tree, requested diff, open files, and cached Thread Git
summaries together. It observes completed `write`, `edit`, `git`, and `terminal`
calls from every watched conversation, including background Threads, and follows
the selected Project's Thread lifecycle and terminal command/lifecycle changes.
Selection, working-directory and Project-state changes, reopening the panel,
returning to the window, and reconnecting to the host also revalidate it.
There is no filesystem watcher: a fifteen-second check while a sandbox surface
is visible covers external changes and Threads whose conversations are not
watched. The file tabs continue to refresh when the right panel is closed.
Refresh signals within 250 milliseconds share a read; changes arriving during
a read retain a follow-up read. Inactive queries are marked stale without being
read, and periodic checks do not restart exhausted failures or lease/path states.
Pending leases retry according to the host's hint, with a one-second minimum and
a three-second fallback. Rejected reads retry at most three times with increasing
delays. Failures offer retry beside the affected content and clear after success.
Background refresh preserves cached content and the reader's position instead
of replacing it with a loading placeholder; directory expansion is retained per
Project and working directory. The Changes tab requests diffs only while shown.

The host owns process-local terminal sessions belonging to a Thread and its
Project sandbox. The `terminal` tool and manual shells use this registry;
internal filesystem and Git probes do not appear as terminals. Each session has
an ID, origin, command, working directory, start time, timeout, state, and live
process controls. Sandbox providers expose streamed execution, stdin, PTY
resizing, and termination of the execution's process session. Plain commands
retain separate stdout and stderr; PTY commands combine them. Manual shells use
PTYs and shell integration reports the current command without inferring it
from keyboard input.

The left sidebar lists terminals below their owning Thread. Agent rows show
`command · elapsed (timeout)`; manual rows show the current command or shell
name when idle. Agent terminals open as tabs beside files. The shell icon in
the left of the conversation footer creates a manual shell in the selected Thread's
working directory and opens a vertically resizable section below its
conversation. This section shows tabs for the manual terminals opened in that
Thread and preserves their emulators while switching tabs. Closing a tab or
hiding a section leaves the process running;
an explicit stop or discard terminates it. Finished agent commands disappear
from both the sidebar and open tabs, with no retained terminal session. Manual
sessions remain until discarded, including an inactive view when their shell
exits. Thread/subtree and Project termination close their owned sessions; host
shutdown closes them too. Sessions are not restored after a host restart.

Live output and a bounded in-memory transcript travel through the Electron
main/preload boundary, never direct renderer HTTP or Socket.IO. Project terminal
snapshots and lifecycle updates keep sidebar rows current; output cursors
reconcile transcript reads with live output on opening or reconnecting. Buffers
are discarded with the session, and truncation of an active session's transcript
is explicit. Terminal data is not written to operational logs.

The terminal tool waits in foreground by default. Explicit background execution
returns its terminal ID immediately and, after the process settles, enqueues one
correlated terminal result into the owning Thread's existing FIFO input queue.
A busy Thread processes it after its current work, an idle Thread takes it up,
and a terminated Thread is never reopened. Foreground execution returns its
ordinary tool result without an extra queued notification. Prompt interruption
cancels its foreground execution; explicit background commands remain owned by
the Thread. Manual shells never enqueue agent continuations. The durable
conversation retains completed tool/background results, not terminal sessions.

A settings window opened from the content footer — its own `BrowserWindow`
loading a page that mounts the settings surface alone, with no conversation,
sidebar or Thread — edits the host's configuration: the configured providers as
an editable table, the execution model with its reasoning effort, the execution
turn limit, and a Credentials section over the host's credential store. A
provider is configured on a page of its own, opened from the providers table,
whose breadcrumb names the provider and whose back control returns to the table.
The kind is chosen there with a searchable combobox and changing it starts the
form over, so a provider is configured by choosing the kind of provider it is —
one of the kinds `packages/llms` offers — and then filling the fields and the
models that kind declares. A field a kind marks `advanced` waits behind the
form's last section, so the screen opens on the necessary values alone. A kind
whose catalog describes its models declares a Models URL, and its models are
chosen from that endpoint: `POST /providers/models` answers what the endpoint
lists, with each model's name, reasoning efforts and advertised parameters, and
the page draws it as a searchable, pageable table with a tick column, a column
per parameter, and a column menu. A model the catalog does not list can still be
named, and is drawn marked. Each
model carries the reasoning efforts it accepts, which the host reads from the
same catalog when it saves, so a kind that declares a models URL
takes them from the endpoint rather than from an operator's typing.
The renderer learns those kinds, fields and models from the host rather than
carrying a list of its own, so a kind added to the library becomes configurable
without a renderer change. A field the kind calls `secret` names a stored
`API_TOKEN` credential instead of carrying a value; a kind that keeps models
edits them as rows, each model with its own efforts, and the execution model and
its effort are chosen among what the selected provider's model lists, which is
the catalog's answer for a kind that reads one. A model that lists no effort —
and a kind that names no models URL keeps the efforts an operator typed — leaves
the execution effort absent, and the agent then sends no reasoning block at all. A
model that lists efforts starts at the one its catalog names as that model's
default, so switching models never leaves a thinking model with no effort at all,
and a model whose catalog pins reasoning on has no state the thinking control
could turn off. A
credential is named and has one of a closed set of kinds that fixes its fields:
`API_TOKEN` is authentication, which a provider key and the GitHub token both
are; `USERNAME_PASSWORD` is authentication with a name; and `GIT` is identity
alone, the username and email the agent's git commands commit with, which is why
it holds no secret at all. A secret is write-only: the host answers whether a
credential holds one and never the secret, so the field always starts empty, an
empty field keeps what is stored, and a value sets it. There is no Save button: a
valid change sends itself once typing settles, on a field blur, and as the window
closes, and the footer reports the revision and update time alongside the save
state. A saved change reaches the next prompt of any Project, including one that
is already running: every credential the configuration names, each provider's
`secret` value and the Git identity and GitHub authentication alike, and equally
the execution provider, model, reasoning effort, and turn limit.

### Project And Thread Contract

The host architecture replaces Session with a Project that owns
one sandbox lease and Threads that own
independent conversations, histories, serial input queues, and working
directories. Threads may have
child Threads; a child executing work delegated by its parent is a subagent,
not a different runtime or a conversation inaccessible to the user. Users can
send prompts to any active Thread, including agent-created children; parent
agents can coordinate their children through host-bound tools.

Distinct Threads execute independently in parallel, with no Doric-imposed
Thread count or concurrent-execution cap, globally or per Project. Execution
within each Thread remains serial. Threads share their Project's sandbox;
each Thread's working directory starts at the sandbox's workspace root
`/workspace` and is inherited by a child Thread at creation. The agent moves it
with the `cwd` tool, and a reader moves the same Thread's with
`PATCH /threads/:id` or the field the right-hand panel footer opens; both reach one
rule, which refuses any path that resolves outside the workspace root. The
existing sandbox-pool capacity governs Projects, not Threads.

The migration replaces the Session-facing APIs and clients without legacy
compatibility adapters. Creating a Project and creating a Thread are separate
operations: new Projects start without a conversation. Before 1.0, approved
schema changes may be consolidated into one clean Project/Thread baseline
without data-conversion or incremental-migration guarantees. Incompatible
legacy development databases must be explicitly recreated; neither startup nor
migrations silently reset an existing database.

The Project/Thread implementation replaces the former Session contract.
The architecture, migration plan, and acceptance criteria are recorded in
`docs/03-tdd/05-project-thread-architecture.md`.

Interrupt targets an active `promptId`, preserves pending inputs and children,
and waits for cooperative cancellation before the next input runs. Terminating
a Thread closes its subtree without releasing the Project sandbox; terminating
a Project closes all its Threads and releases its lease exactly once after
active work settles. Neither operation rolls back sandbox effects.

Completion, failure, or cancellation of a delegated request automatically
enqueues a correlated result for its parent: a ready parent runs it, a busy
parent processes it in FIFO order, and a terminal parent is never reopened.
Human follow-ups in a child do not bounce responses back to its parent.
The thread delegation tools act only on direct children in the same Project,
reached through the per-prompt host facade; each child has its own history, not
an automatic copy of its parent's history.

Within `agents/doric/src/lib`, Direct owns `agents/direct/executor.ts` and
`agents/direct/prompts/system.ts`; the former one-module-per-coordination-tool
set now ships in `/bundles/threads`. The system prompt file exports only one
constant literal template string; dynamic bundle skills are appended by the
executor, not encoded as arrays of prompt lines. Shared lifecycle and control
live in `workspace`: `runner.ts` builds the prompt-scoped host facade, and
configuration, HTTP composition/errors, and event transport/safe serialization
live in `config`, `http`, and `events` respectively. The database
client and VM registry remain `database.ts` and `vms.ts` at the lib root.
This organization does not change bundle ownership or runtime behavior.

### Current Runtime

Repository-owned executable bundles live as individual Nx packages immediately
below `/bundles`; each bundle owns its package metadata, TypeScript build, and
isolated output below `agents/doric/dist/bundles/<name>`. `/bundles/core` owns
the built-in `cwd`, `edit`, `find`, `grep`, `terminal`, `tree`, `web`, and
`write` tools; the `cwd` tool reports the calling Thread's working directory and
moves it, and a relative path a tool is given resolves against that directory
rather than the workspace root, exactly as `cd` resolves one against the current
directory; a move that resolves outside the workspace root changes nothing. `/bundles/git` owns the routable `git` tool plus focused skills for
cloning, commit preparation, conflict resolution, rebasing, remote
synchronization, and linked worktrees. The Git tool executes structured argv
directly without shell interpretation, forces non-interactive Git behavior,
bounds stdout and stderr, and exposes no dedicated credential input.
`/bundles/threads` owns the delegation tools `thread-spawn`, `thread-list`,
`thread-get`, `thread-events`, `thread-send`, `thread-interrupt`, and
`thread-terminate` plus
focused delegation, inspection, and steering skills.
`packages/bundle` owns strict manifest validation and runtime loading.
Doric loads only immediate bundle directories, in lexical order, from its
built `dist/bundles` artifact. Manifests explicitly order every resource and
carry `alwaysAvailable` flags for tools and skills. Runtime tools are compiled
ESM `.js` default exports created through `packages/tool`; each export is an
inspectable `ToolFactory` that Doric binds, in its composition root, to a
sandbox and to a per-prompt `Host` capability facade. The loader validates the
definition, input, and output schemas and never inspects handler arity. Runtime
TypeScript is rejected. Skill `allowed-tools` references resolve
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

`packages/host` publicly owns the `Host` capability facade that every tool
handler receives as its second argument, after the sandbox. It is types only: a
bundle depends on this package for the contract, never on `agents/doric`
internals, and the host implements it in the composition root. A `Host` is
prompt-scoped; it closes over the calling prompt's Project and Thread, so
`host.threads.*` reaches only that prompt's direct children and stops when the
prompt ends, and `host.workspace.*` reports and moves only that prompt's own
Thread's working directory. Today's namespaces are `threads`, `workspace`, and
`terminals`; the latter starts tracked foreground or background commands in the
calling Thread's sandbox without exposing other Threads' sessions. Background
process ownership survives completion of its originating prompt;
future namespaces
(`config`, `vms`, `providers`) are added only for a concrete need, never as a
state dump, a leaked `ProjectRuntime` or Prisma row, or an `invoke` escape hatch.
Exposing a host facade to every tool handler is an approved tool-privilege
expansion under HC-004 and HC-007: a bundle previously reached only the sandbox.
Because a tool result goes to the model, the facade exposes capabilities, never
credential reads; secrets stay in the host's credential store. `loadBundles` still enforces
globally unique names, so a bundle tool cannot collide with a host capability.

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
one tag. No call requests structured output or schema injection. OKF's
completion boundary discards provider diagnostics and causes; composition
roots configure private providers with a disabled logger. Content privacy is
owned by OKF and its host, not by a flag in the LLM package. Generated
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
cosine similarity. Embeddings must be dense arrays of finite numbers with the
configured dimensions and non-zero magnitude; the index snapshots them before
storage and rejects malformed results on both addition and search.
Stored and query embeddings are normalized once with magnitude-safe scaling;
exact vector search then uses dot products. Lexical search uses an inverted
posting index and computes IDF once per query term using current corpus
statistics. Both indexes select exact top-K results with bounded heaps and
preserve insertion order for score ties.
Both indexes store caller values through per-add text
transformation. Hybrid search queries its injected lexical and semantic sources
concurrently, fuses their bounded ranks with equal-weight reciprocal rank fusion
using a fixed rank constant of 60, deduplicates by a caller-provided canonical
key, and resolves fused-score ties by that key. It has no persistence or
provider integration.

`agents/doric` receives complete singleton configuration replacements through
`PUT /config`. It persists only provider IDs, the kind each provider is, the
configuration values that kind declares, the models each provider offers, one
`models.execution` profile, and `execution.maxTurns`. A provider's kind, the
fields it declares and the model list it keeps are `providerKinds` in
`packages/llms`; the host serves that catalog unchanged at `GET /providers/kinds`
and builds each configured provider with `createProviderForKind`, so a stored
provider carries a value for every field its kind requires, leaves an optional
field it has no value for out rather than storing it empty, and carries the model
list its kind keeps — empty until an operator names models — and nothing else. A
kind that keeps `reasonings` keeps the reasoning on each model: the reasoning
efforts that model accepts, the effort its own catalog names as the model's
default, and whether that catalog pins reasoning on; a kind that keeps only
`models` carries a name alone. A kind whose catalog describes its models declares
a models URL, and the host reads it on every configuration write — and, for a
provider page, through `POST /providers/models`: each listed model takes the
reasoning that catalog describes, a model the catalog does not name takes none,
and a catalog that cannot be read leaves that provider exactly as it was. An
execution profile carries an effort exactly when its model lists one, and the
host writes it on every save: the effort that model's own catalog names as its
default when it names one, and its first effort other than `none` otherwise. A
profile that already names an effort is kept as it stands, including the `none`
that asks for no reasoning; a model that lists none carries no effort at all,
which is why the column is nullable, so no prompt carries a reasoning block the
endpoint never offered.
The OpenAI-compatible kind reports the configured provider's own
id and name as its identity rather than taking them as fields, so nothing in the
catalog asks an operator for an identity the provider already has. The settings
surface and the agent therefore agree on what a provider needs without either
hard-coding the other's list. Each
Project created by `POST /projects` records the active configuration generation
and its immutable JSONB snapshot as what it was created with; that record is
provenance, not authority. Every prompt reads the configuration in force when it
runs, so a provider, model, reasoning effort, or turn limit chosen in the
settings reaches the next prompt of any Project, including one already running.

`agents/doric` owns a credential store: named `credential` rows of a closed kind
set, where the kind fixes the field set. `API_TOKEN` is authentication and the
provider keys and GitHub token are both ones; `USERNAME_PASSWORD` is
authentication with a name; and `GIT` is identity alone and therefore holds no
secret. `credentialFields` in `src/lib/credentials` is the one rule the Zod
input schemas and the service validation both derive from, so a value the kind
forbids is rejected before it is stored. A secret is stored as a versioned
AES-256-GCM envelope under `DORIC_CREDENTIAL_KEY`, a base64 32-byte key, so the
key can rotate later. The host refuses to start when a stored secret exists and
that key is missing or unusable, and it never serves an unreadable secret as an
empty one. References resolve two ways: a provider or configuration reference
names a credential by id, and an unconfigured integration asks for the kind it
needs, where no match leaves it off and several matches are a refusal to guess
rather than a silent first match.

`packages/sandpool` owns process-local `SandboxSession` capacity, FIFO leasing,
background warming, bounded factory-attempt batches, replacement, and disposal.
It accepts an injected sandbox factory, depends only on the public `sandbox`
contract at runtime, never reuses released sessions, and has no
provider-specific creation policy or persistence. An acquisition may name the
caller it serves: a named acquisition provisions a session for that identity
instead of taking a warmed one, so a Project always leases a sandbox made for it,
while an unnamed acquisition keeps taking the warmed session; Doric warms none
because every acquisition it makes names its Project. A batch rejects pending FIFO
acquisitions and heat waiters after `maxCreateAttempts` consecutive factory
failures; the default is three, and later demand starts a fresh batch so a
recovered provider can serve new work. Doric explicitly uses that three-attempt
limit, allowing its execution failure path to move affected Projects
from `queued` to `failed`. Its capacity option is `maxSandboxes`, and a lease
guards SSH access exactly as it guards other operations. `packages/sandbox` owns
the provider-neutral
`SandboxProvider` and `SandboxRuntime` boundary plus workspace, Git, file, diff,
repository discovery, network-policy normalization, and disposed-session
behavior. A session may be provisioned for a durable workspace: the Docker
provider keeps it in the volume `doric-workspace-<identity>`, binds that volume
at the sandbox root, and labels the container with it, so provisioning the same
identity again reattaches the same files — across a container, a host restart,
and the next lease for that Project — and `discardWorkspace` removes it when the
Project is deleted. A sandbox provisioned without a workspace binds nothing and
loses its files with the container, which is what the Firecracker profile still
does: its guest disks live under the per-run state directory. The durable volume
holds its files on the host's own storage, so a sandbox's `diskMiB` bounds only
the container's writable layer. It also owns the
one implementation of the workspace visibility rules — root confinement,
`.gitignore` handling with negation, hidden entries except `.agents`, and
directories-first ordering — which the `/bundles/core` `tree` tool and Doric's
Project file routes both consume, so neither can drift from the other; a scoped
diff is expressed through `SandboxDiffInput.paths` rather than by callers
building Git argv. Every sandbox has
explicit CPU, memory, and writable-layer disk resources; networking is disabled
by default, optional SSH is key-only and loopback-bound by default, and
effective egress requires IP-literal DNS. Doric explicitly provisions its agent
sandboxes from the image named by `DORIC_SANDBOX_IMAGE`, which defaults to the
multi-architecture `node:22-bookworm` image, with the `1.1.1.1` DNS resolver so
selected Git skills can reach public remotes. That default ships Git; the
sandbox image Doric builds from `agents/doric/.sandbox.Dockerfile` ships Git and
the GitHub CLI. The image is a deployment choice the host reads from its
environment rather than a compiled-in value, and Firecracker resolves an
anonymous public OCI image, so a locally built tag needs publishing, or the
variable pointed at a public image, before that provider can use it.
`DORIC_SANDBOX_SSH=true` adds loopback-bound, dynamically allocated
user SSH access so a trusted same-host user can inspect the active Project
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

`agents/doric/.Dockerfile` reproducibly builds the agent and every built-in
bundle, pinned Firecracker and jailer, Linux 6.18 guest kernel, static BusyBox
and Dropbear bootstrap, initramfs, OCI/ext4 tooling, networking tools, and
OpenSSH client. Its Linux-only Compose profiles provide either the Docker
socket plus host-network firewall access or KVM/TUN/cgroup/state/cache access
without a Docker socket. The privileged Firecracker profile is a development
and e2e harness, not a production isolation boundary. Local deploy credentials,
including the PostgreSQL password, live only in the git-ignored
`agents/doric/.env` (see `agents/doric/.env.example`); they are never committed
or baked into the image. Doric acquires one pool
lease when each persisted Project is created and retains it across all its
Threads and prompts. It binds every bundle tool to that sandbox, propagates
cancellation through acquisition and active provider calls, and releases the
lease exactly once on termination, acquisition failure, or shutdown. Projects
have no automatic expiry and therefore occupy capacity until explicitly
terminated.

Doric initializes an otherwise unconfigured Express application and attaches
a Socket.IO server to the same HTTP listener. The listener binds to
`DORIC_HOST` and `DORIC_PORT`, defaulting to `0.0.0.0:3000`; the Doric image
exposes port 3000. Its modular Express router exposes `GET /vms`, which returns
the IDs and selected provider names of runtimes successfully provisioned by
this Doric process and not yet successfully disposed. `GET /vms/:id/ssh`
returns the selected provider, owning live Project ID, and complete
`SandboxSshAccess` only while that VM is leased to an active Project;
idle, releasing, and disposed VMs never expose access. The registry wraps the
provider at the composition boundary and the workspace service owns the
process-local lease association. `POST /projects` accepts only a display name,
not a prompt, and includes a stable Project SSH subresource link while
preserving asynchronous queued creation.
That subresource reports pending acquisition, returns the active VM and SSH
access, or reports unavailable or expired access after release. Private keys
remain ephemeral provider-managed sandbox state and HTTP response data;
provider disposal owns their key-file cleanup. They are never persisted in
Doric's database, logged, included in lists, or emitted through Socket.IO. SSH
HTTP responses prohibit caching. The lease additionally backs four private
Project subresources that prohibit caching and answer with the same lease
states: `GET /projects/:id/files` lists one workspace directory with per-file
sizes, `GET /projects/:id/tree` lists the whole workspace as one nested tree in a
single read — each directory carrying its own `children` and no per-file size,
because one recursive walk measures nothing — `GET /projects/:id/files/content`
reads one workspace file up to a fixed byte cap with truncated/binary flags, and
`GET /projects/:id/diff` returns one entry per Git repository in the workspace
tree — each repository's root path, its diff, and its change list, including
untracked files — with discovery stopping at each repository boundary, exactly
as Git reports a nested repository. A
workspace-relative path is normalised, resolved against the workspace root, and
rejected when it escapes; the routes never log file content or diff bodies.
REST additionally owns `GET/PUT /config`, the `/credentials` create, list,
patch, and delete surface,
named Project and Thread creation, rename through `PATCH`, cursor listing,
detail, FIFO prompt acceptance through `POST /threads/:id/prompt`, history
rewind through `POST /threads/:id/rewind`, ordered event
replay with an optional exclusive `afterSequence`, targeted prompt interruption,
idempotent termination, and terminal-only deletion. Each Thread turn records the
provider-history length it started from, so rewind truncates that history
exactly at a turn boundary, removes the edited turn and every later turn from
the durable event log, drops their checkpoints, and then accepts the edited text
as a normal human input. Rewind refuses while the Thread is running or has
queued input, so the FIFO queue never executes on truncated history. Project and
Thread names
are trimmed, exclude NUL, and contain 1 to 80 Unicode code points. `/projects`
owns environments and `/threads` owns conversations; there are no `/sessions`
routes or compatibility aliases. Public Project and Thread list/detail
representations contain identity, name, state, ownership, timestamps,
applicable revision/sequence and sanitized error codes, not prompts, messages,
events, results, or SSH credentials.

Socket.IO uses separate `/status`, `/projects`, and `/threads` namespaces.
`/status` accepts no subscription input or application payload and provides the
long-lived connectivity signal consumed by the Electron main process. Project
and Thread subscription parameters travel through namespace-scoped handshake
auth. The status and Project namespaces multiplex those sockets through one
process-long Manager and one Engine.IO connection, while each watched Thread is
given a Manager and connection of its own: closing that connection is what ends
the Thread's subscription, so a Thread the renderer has stopped watching can
never keep publishing into a window. A subscription forwards only updates that
name its own Project or Thread. Project subscriptions expose environment and
tree updates; Thread subscriptions use `threadId` and optional `afterSequence`
for durable playback followed by live events without a replay/live gap. Each
Thread event is `{ projectId, threadId, promptId, sequence, type, event,
createdAt }`.
PostgreSQL is the event source of truth: an event and the Thread's contiguous
last sequence are committed before live emission. There is no global event
ordering between Threads; Project reconnection refreshes its snapshot and tree.

`agents/doric` owns its Prisma ORM 7 schema, generated client configuration,
and versioned PostgreSQL migrations. Production uses one adapter-pg Prisma
client per process and never applies migrations implicitly during HTTP startup.
PostgreSQL stores the singleton configuration, the credential store, normalized
provider/model rows,
Project names, colors and configuration snapshots, Thread names, parentage and
provider-ready message history, and ordered JSONB Thread events. The credential
store is populated by migration from the former provider environment
variables and the former plaintext GitHub identity columns; a provider keeps its
row and receives a named `API_TOKEN` credential whose secret is empty until its
operator supplies a key, and a legacy GitHub token is not carried as plaintext
because AES-256-GCM only runs in the host, so its operator re-enters it once. Before 1.0,
approved schema changes may be consolidated into the clean Project/Thread
baseline rather than retained as incremental migrations. Existing incompatible
development databases must be explicitly recreated. Session-era migrations and
data-conversion SQL are removed as part of the approved cutover.
Startup resumes every non-terminal Project and Thread instead of failing them:
the Project becomes `queued` because it needs a sandbox again, the Thread becomes
`ready`, and an interrupted prompt receives a durable pause marker before the
boot queues it for automatic resumption. Accepted inputs that never started are
queued too. Acquisition runs in the background, so a full sandbox pool does not
block the HTTP listener. Reader-paused prompts wait for an explicit resume.
A record a crash left `cancelling` is completed to `cancelled` instead, so a
restart cannot revive work the reader terminated; events remain replayable.
Physical Thread deletion requires its entire subtree to be terminal; Project
deletion requires every Thread terminal and cascades to its Threads and events.
The local Compose surface pins PostgreSQL 18.4, mounts its PostgreSQL-18 volume
at `/var/lib/postgresql`, runs migrations as a one-shot dependency, and starts
either Doric sandbox profile only after the database is healthy and migrations
complete.
Doric startup emits safe structured `info` logs for its listener and sandbox
selection, PostgreSQL client initialization, sandbox limits, bundle resource
counts, active configuration revision and model profiles, Project/Thread
reconciliation, mounted interfaces, and listener readiness. Startup failures
identify only the active bootstrap stage; they do not retain or emit database
or provider URLs, credential values, prompts, caught
diagnostics, causes, or thrown values.
Configuration, Project, Thread, and Credential routes remain unauthenticated on
the existing
`0.0.0.0` listener. Provider base URLs and credential references are
intentionally configurable through the open PUT, so deployments must keep this
listener on an isolated trusted network. The stored configuration holds no
secret at all: it names the credential each provider and each GitHub-related
integration uses, and `GET /config` answers exactly the shape `PUT /config`
accepts. Each named credential is a different resource whose secret never
appears in a response — `GET /credentials` answers whether one exists — and whose
value is redacted from events, logs, and Thread replay instead of being handed to
a tool. The credential routes follow one rule: an absent or `null` field keeps
what is stored, `''` clears it, and a value sets it, while a kind is immutable
after create and a credential a provider or the configuration references cannot
be deleted. The named credentials therefore reach a Project through the
configuration in force, on its next prompt. The host applies the Git identity and the
GitHub token to a Project's sandbox separately: `git config user.name/user.email`
for the identity, and, when a token is configured, a `credential.helper
store` credential file written 0600 plus the `~/.config/gh/hosts.yml` written
0600 that authenticates the sandbox's GitHub CLI, when the lease is acquired and
again whenever the current pair differs from the one the sandbox holds, because
a rotated secret must reach a Project that is already running. Credentials are
therefore applied per lease and never baked into the sandbox image. The token
travels only through the sandbox process environment, never through a tool
argument, a tool result, an event, or a log line. Agent events intentionally expose
reasoning, provider replay, tool input/output, results, and serialized errors;
configurable credential values are redacted before persistence. Event bodies are
never written to operational logs.

Sandpool and each repository-owned LLM provider require an injected
`pino.Logger` and create their own component child logger. They emit only safe,
structured `debug` operation logs: lifecycle and allowlisted counts/identifiers,
never prompts, model inputs or outputs, stored values, vectors, credentials,
URLs, headers, diagnostics, causes, or thrown values. Composition roots control
logging through the injected logger; there is no per-request privacy flag.
They pass their existing logger to these dependencies; private OKF provider
calls use a disabled Pino logger.

Doric supports OpenAI, raw OpenRouter, unified OpenRouter, LM Studio native,
LM Studio OpenAI compatibility, and Codex as provider integrations. The unified
provider uses stable OpenRouter Chat Completions, a 15-minute live model
capability cache with stale-on-error fallback, and curated profiles for OpenAI,
Anthropic, Gemini, Gemma, DeepSeek, Kimi, Mistral, Qwen, Llama, xAI, GLM,
Cohere, and MiniMax. Catalog refresh is shared independently of individual
request cancellation; each caller may cancel its own wait. It maps tool choice
and sequential controls, forwards only already-compatible strict tool schemas,
and preserves ordered opaque
`reasoning_details` for replay. It sends `parallel_tool_calls` only when the
live model catalog advertises that parameter; otherwise it omits the transport
control, reinforces sequential requests with a model-facing instruction, and
relies on the Agent's atomic tool-batch validation before execution. The live
catalog is the contract for a model's capabilities: the request model must be
one the endpoint lists, and a proxy alias that renames a model is not supported,
so those requests fail with the endpoint's own answer rather than a guessed
profile. Curated profiles remain for what a catalog cannot state — whether a
model's tool schema may be sent strict, how much opaque reasoning detail replays,
and which laboratory cannot combine forced tool choice with reasoning — and as
the fallback for a capability read that failed.
Direct
tool-free schemas select advertised JSON Schema, JSON object mode, or a
deterministic schema prompt, then validate with the original Zod schema and
allow at most two correction attempts. Structured streams emit only after
buffered validation. Tools plus a direct provider schema and other
non-emulatable combinations fail explicitly before completion.
The raw OpenRouter provider additionally exposes typed System One decisions for
Jev through `POST /api/alpha/decisions`. A decision evaluates one JSON state
against one or more `noul`, `choice`, or `score` questions and returns the
model-resolved typed answers and normalized usage. Decision payloads are not
adapted into chat completions or written to operational logs.
The opt-in paid unified-provider conformance runner reserves stdout for its
final JSON report, permits up to 1,024 output tokens per request, and emits Pino
progress to stderr. Failures identify the exact structured-output, tool-call,
or tool-replay stage and expose the provider error fields retained by the LLM
boundary; the runner owns the decision to display those diagnostics. An empty
structured response diagnostic identifies its finish reason and available output/reasoning token
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
`medium`, `high`, `xhigh`, or `max`, or absent; legacy model `reasoning` remains supported as
the same effort alias. Config parsing rejects models that provide conflicting
`effort` and `reasoning` values. Provider requests may include top-level
`effort`, which takes precedence over legacy `flags.reasoning.effort`.
Provider requests may also control tool selection and parallel tool calls.
The OpenAI Responses adapter sends `store: false`, preserves every opaque
response output item for exact replay, forwards incomplete tool results, and
marks schemas strict only when their unmodified JSON Schema is already
strict-compatible. Replay and encrypted reasoning never enter provider
operational logs.
`packages/llms` does not classify or sanitize content and has no
`sensitiveOutput` flag. Provider errors may retain response excerpts,
diagnostics, and causes without redaction. Excerpts are bounded for diagnostic
volume, not privacy. Consumers own display, persistence, and privacy policies;
this does not change host credential handling or add payloads to operational
logs. HTTP stream-opening failures retain structured status and diagnostic
information and are normalized to provider errors without changing cancellation.
Provider requests may set
`flags.includeStructuredSchemaOnSystemPrompt: true` together with `schema` to
append one deterministic, collision-safe Markdown system message containing
the converted JSON Schema. Authored system messages retain their order before
that generated message, followed by all non-system messages in their original
order. The flag is additive to provider-native structured-output fields;
omitting it, setting it to false, or using it without a schema leaves messages
unchanged.
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
Agent complete and stream runs check cancellation before provider and tool
execution and after awaited lifecycle callbacks and streamed boundaries.
Already-running tool handlers may settle, but cancellation prevents subsequent
tools and provider turns from starting. Interrupted, failed, or closed runs
append incomplete results for unresolved assistant tool calls, without
duplicating completed results or creating synthetic tool-call records.
Callback exceptions retain their identity and do not misreport a completed
tool as failed. Direct checks cancellation again after awaited event writes.
Agent runs may set `resume: true` to continue their supplied history without
appending the input again, in both complete and stream modes. Direct uses this
when a persisted checkpoint shows that the input is already stored, preserving
the original message order across repeated resumptions. It supplies incomplete
results only for unanswered calls in an interrupted tool batch.
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

`packages/state-machine` owns reusable, process-local typed transition
execution. A definition stores only its exhaustive handler map and infers its
available handler names from that map. Each run keeps its context, current
handler, and current state local and resolves with a finished, domain-failed,
or engine-error result. Every handler receives the same state object type but
explicitly supplies the next state to a transition. A transition accepts only
an available handler name. Top-level state must be a plain data record with
this realm's `Object.prototype` or a null prototype; nested values are
unrestricted. The public record constraint cannot prove prototypes, so runtime
checks the initial and transition states. Initial state is passed by reference.
The executor shallow-copies transition state after the handler returns or
resolves, before the next handler, equally for literal and helper actions.
Copies normalize null prototypes to `Object.prototype` and share nested values.
Each run creates one frozen actions object; control is local to that run, not
deep isolation of caller-owned values.
Error metadata uses `data.handler` for the handler name, distinct from the
terminal state object. Unsupported initial state returns `handler_failed` with
a `TypeError` cause; unsupported transition state returns
`invalid_handler_return` with the source state. Thrown values, async rejections,
and exceptions during action inspection or transition copying become
`handler_failed` with the unchanged cause. Missing handlers retain the
`missing_handler` code. It owns no workflow policy, persistence, listeners,
recovery hooks, or external side effects.

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

Credentials and secrets must not be printed, logged, or committed, and must not
be persisted outside one explicitly approved place: the host's credential store,
which keeps each secret as an AES-256-GCM envelope under `DORIC_CREDENTIAL_KEY`,
answers only whether one exists over the API, redacts it from events and logs,
and keeps it out of tool payloads. Prefer dependency injection and
explicit configuration objects for sensitive runtime inputs.

Doric Direct Thread replay is durable in PostgreSQL. Projects transition from
`queued` to `ready` after sandbox acquisition; Threads wait for their Project
and each FIFO input transitions `ready -> running -> ready`. Project and Thread
termination use `cancelling -> cancelled`; acquisition or reconciliation
failures use `failed`. A host stop is not a termination: it releases the lease and
writes the Project back as `queued` with its non-terminal Threads `ready`, pausing
the prompt that was running so the next boot takes it up again, so the next prompt
reacquires a sandbox for that Project — the same durable workspace on the Docker
provider — and runs. A reader's own stop pauses the same way, and only the reader
takes that prompt up again; terminating a Project or Thread is the terminal act,
not stopping one. Reading a Project that holds no lease still answers
`pending`/`unavailable` and never acquires — except for a Project that holds an
unfinished prompt whose interruption came from the host: the boot resumes it
itself, because work the reader asked for and that the host interrupted is work
the host owes them, and only such a Project pays for a sandbox before anyone
asks. Termination needs no live runtime: a
Thread whose Project holds no lease still takes itself and its subtree through
`cancelling -> cancelled` durably, so a reader can terminate and delete a resumed
Thread without prompting it first. A fresh Agent per prompt
receives a fresh tool-call store, every bundle tool bound to that sandbox and
the per-prompt host facade, the deterministic
all-skills system prompt, and
`createMessageStorage(...)` initialized from that Thread's exact persisted
provider-ready history. Success and failure both persist the resulting complete
or partial history, redacting configured credentials and replacing the
characters PostgreSQL refuses (U+0000 and unpaired surrogates, which binary tool
output can carry) with U+FFFD rather than failing the Thread. Provider/tool failures
return the Thread to `ready`; history or event persistence failures fail the
Thread closed rather than executing queued inputs on stale history. Acquisition
failure is terminal for the Project. Cancellation and lease cleanup continue
even if cancellation-state persistence fails.
Doric adds `history.truncated`, `prompt.accepted`, `prompt.paused`,
`prompt.resumed`, `prompt.finished`,
`agent.failed`, and
`agent.cancelled` events around the Agent stream. `prompt.accepted` carries the
input text and its source after the standard configured-credential redaction.
`prompt.paused` carries the reason an interruption left the prompt unfinished —
`host_stopped` when the host stopped, `host_restarted` when a restart was only
discovered at the next boot, `reader_stopped` when the reader stopped the run —
and `prompt.resumed` carries the attempt number of a prompt the host took up
again. An interrupted prompt is resumed from the provider history persisted as
the run advanced, so it continues where it stopped, and an attempt budget counted
from those events stops a prompt that keeps interrupting the host: it is closed
as a failure carrying the `resume_exhausted` code. Closing an exhausted delegated
prompt also accepts its correlated result for an active parent in the same
transaction; the boot queues that result once. `prompt.finished` carries the
input source, terminal status, and response text;
successful completion requires history persistence. Clients use it, not the
inner `agent.finished`, to acknowledge prompt completion. `history.truncated`
carries `{ type, afterSequence }`, where `afterSequence` is the sequence of the
last surviving event or `0` when none survives; it is appended before the
replacement input is accepted, and sequence numbers are never reused, so the
discarded range leaves a gap rather than a reused number.
Delegation results are redacted before entering the parent's input queue.

The conversation states the two lifecycle events as markers between the blocks
they sit between: a pause reads as a quiet row — its icon, and the reason it
paused — and a resume as a quiet row naming its attempt, with the option to take
a reader-paused prompt up again offered on that row. A prompt closed because its
attempts ran out is the one that is not quiet: it reads as a warning, alert icon
and all, in the theme's own warning tone, because it needs the reader's decision.
Arbitrary Agent event values are converted to JSON without dropping reasoning,
replay, tool payloads/results, errors, or defined stacks, causes, and own error
properties. Undefined object properties are omitted. Undefined array entries,
cycles, and other non-JSON values receive explicit markers, and configured
credential values are redacted. Process-local runtime state owns live Project
leases, independent Thread FIFO queues, abort controllers, and Socket.IO
subscribers. It is not the
replay source of truth, does not resume accepted or queued prompts by itself
except through the boot pass described above — the one place a host takes work up
again without a reader asking — and requires no distributed Socket.IO adapter because Doric currently
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
