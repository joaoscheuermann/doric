# Doric Grounding

Last reviewed: 2026-08-24

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
events, results, or SSH credentials.

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
