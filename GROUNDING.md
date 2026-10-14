# Doric Grounding

Last reviewed: 2026-10-12

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

The user has requested a future bundle architecture that can supply providers,
executors, events, hooks, workflow nodes, domain models and durable storage,
and the entire desktop UI, including its root layout and every product
component. Public UI surfaces can be bundle-owned Web Components; versioned
services let bundles call one another, while durable events and local signals
retain distinct delivery contracts. Bundles may also own Electron-main
features such as the local history cache. In that target the app lifecycle is
defined by hooks: the app itself defines the default lifecycle hooks and the
basic features, including one technical splash and recovery surface outside
any bundle; the core bundle opens windows and registers menus from those
hooks and decides what other bundles may add to them; and any bundle may
define hooks of its own so that other bundles can modify its behavior. The
host is the source of truth for installed bundles and the composition, which
names one core bundle activated first; the desktop downloads and verifies
bundle artifacts during the splash and serves them from a single
`doric://app` origin, with React, Lexical, the shadcn components, Tailwind and
theme tokens provided as shared platform packages. Client bundles may own
React-backed Web Components, while Electron creates the actual windows and
keeps the preload and IPC boundary.
On 2026-10-08 the user approved, as the target of that proposal, one process
per bundle generation on the host and one Electron `utilityProcess` per
generation for desktop-main code; this is the explicit HC-003 approval for
that multi-process design, and it takes effect only as the migration steps are
implemented and validated. The source-grounded target and migration sequence are
recorded in `docs/architecture/bundles.md`, which links the concept documents
under `docs/architecture/bundles/`; concrete UI examples live in
`docs/architecture/bundles/react-web-components.md`,
`docs/architecture/bundles/windows.md`,
`docs/architecture/bundles/navigation.md` and
`docs/architecture/bundles/layout.md`. The proposal writes bundle
contracts (hooks, services, events, commands, settings and storage types) in
zod through the `define*` family from the browser-safe `bundle/contracts`
subpath of `packages/bundle`, modeled on `defineTool`, and generates the
canonical JSON Schema from zod at build time. As with tools, a service method
(`defineMethod`) and a command (`defineCommand`) carry their `execute(input,
call, services)` in the definition, which lives in the providing part; a
bundle's public `contracts/` entrypoint exports only typed references
(`ref<typeof definition>(id)`), so consumers never import implementation code. In the revision of 2026-10-09,
a bundle's activation context carries only `services`: hooks, log, settings,
secrets, tools, skills, storage, events, models, commands, UI, regions,
windows and menus are service contracts that the `core` bundle provides by
default and that any other bundle may replace when the composition selects it
in `providers`; the platform registers its lifecycle hooks in whichever
`hooks/v1` provider is active, and keeps only what must work without the
core (catalog, diagnostics, splash and recovery, `doric://app`, IPC,
generation processes and the native window and menu APIs). Bundles use
minimal names (`core`, `runtime`, `postgres`, `chat`, `layout`, `files` and
so on), contracts are named `<bundle>.<name>/vN`, basic services by domain
alone, and platform contracts `doric.*`. Contract definitions expose only the
properties they need (for example, `defineHook` takes `kind` and `input`,
`defineEvent` takes `type` and `payload`, and `defineService` takes only
`cardinality` as an option), and security is not a design concern of the
proposal. A route is a URL path (`/projects/:projectId/threads/:threadId`)
registered with a `create` function and an optional `parent`; a window is a
key plus a path; the core provides the router (`navigation/v1`), the
`<core-outlet>` element that shows the active route like a React Router
outlet, `ui/v1` and `regions/v1`, and the `layout` bundle registers `/` with
the workspace frame, its regions and its tabs. These files are proposals: the current
package responsibilities and runtime behavior below remain authoritative until
the relevant migration steps are implemented and validated. Migration stages 1
to 10 are implemented and described under Current Runtime, together with the
platform/bundle boundary described under Platform Boundary, which replaces the
provisional host adapters stage 1 introduced: the platform knows no bundle
concept, and the bundles own their own.

`app/backend/doric-host` is the Direct agent host. It exposes long-lived sandbox-backed
Projects and independent chat Threads through REST and Socket.IO, while the
reusable agent loop remains in `packages/agent`.

`app/desktop/doric` is the Electron desktop application. Serving it — the `serve` target `nx serve doric-app`, which `npm run doric:dev` drives through `nxe:serve:backend` — launches Electron with Chromium's sandbox disabled (`--no-sandbox`) only when the process runs as root, the case a root container is, or when `DORIC_ELECTRON_NO_SANDBOX=1` opts in explicitly; a normal user keeps the sandbox. Its sandboxed, context-isolated
windows load the shell built by `app/desktop/doric-renderer`, which since migration
stage 9 only boots the client bundles; the UI described below is drawn by the
`layout`, `chat` and `settings` client bundles, the feature bundles' client parts
that `layout` hosts, and the core's outlet, using
Tailwind CSS and the shadcn/ui components and Radix primitives of
`packages/desktop`. Where this section says "the renderer", it means those
bundles in the window.
All app footers use font weight 400, including their nested text and controls,
enforced by one shared stylesheet rule.
The conversation footer shows OpenRouter context usage without a text
prefix or progress bar and an approximate dollar total. Vertical dividers separate
the execution picker, context text and cost. Context uses the selected Thread's last
reported input count and the capacity advertised by that call's model catalog;
an absent capacity or measurement stays unknown. OpenRouter response-start events
carry the optional catalog capacity. Costs sum reported account charges across
the selected Thread and all existing descendants, including unopened Threads.
Clicking the total shows the current Thread's own charges and a collapsed
Sub Threads subtotal for all descendants, each with calls and compact input/output
token counts. Expanding Sub Threads shows a subtly shaded, non-scrolling list of
descendant titles, their own charges and the same calls/input/output metrics.
Long titles truncate with an ellipsis. The list's background meets the popover's
edges without container margin or padding; each row aligns its content with the
summary above.
The toggle uses ChevronsUpDown to open and ChevronsDownUp to close.
The popover follows the conversation trail's bordered surface and shaded footer,
with the total below a divider. Partial costs carry an asterisk with an explanation;
cached/reasoning details and accounting descriptions stay off this compact surface. Missing
costs make the aggregate explicitly partial; zero-cost calls remain free, and
cached/reasoning tokens are details, never added again to input/output totals.
The host's `GET /threads/:id/usage` reads this aggregate through semantic Electron
IPC. The visible footer refreshes it every three seconds and on window focus.
Thread JSONB usage snapshots are updated atomically with response events, replacing
repeated usage snapshots within a call. These cumulative charges survive rewind;
context is reconstructed from the surviving events. Old Threads lazily derive
their totals from retained events until the next response event materializes them.
When old measurements lack capacity, the usage read fills it from the current
OpenRouter catalog for the measured model, marking that source in the tooltip.
New measurements retain the configured provider id; legacy measurements resolve
only when exactly one OpenRouter provider lists that model. Recorded capacities
remain authoritative. Historical `unified` events remain readable for accounting.
The OpenRouter provider shares its model catalog between
model listing, validation and execution: 15-minute freshness, one concurrent
refresh, a 5-second request timeout, stale fallback and 30-second failure backoff.
Deleting a Thread deletes its accounting along with it. Costs not returned by an
interrupted provider call remain unknown; the host makes no generation audit call.
The main process alone communicates with Doric, at the origin the deployment
names (`127.0.0.1:3000` by default, `DORIC_HOST_URL` otherwise): an app window
never opens HTTP or Socket.IO, and its preload exposes only
`window.doric.desktop`. A screen view window is not an app window and is the
exception: it carries no preload, and its own `WebContents` loads that origin's
page. Since migration stage 9 every Project, Thread,
configuration, terminal and usage operation, each Thread watch, the
selected-Project tree watch, connection status and the native-notification
write are contract calls and streams that main's one `doric:desktop`
dispatcher routes over the host bridge (`/doric/bridge`) or to the desktopMain
generation; the semantic IPC channels and the main-process Thread history are
gone. Desktop pushes skip detached or destroyed renderer frames, including
disposal during a native send. Platform console logging tolerates closed output
pipes so logging cannot crash the main process after its launcher exits.
The Thread history snapshot is the `history` bundle's
`history.snapshots/v1` cache in desktopMain. The renderer keeps the
Threads it has read for each Project; the sidebar renders the selected Project's
tree while live updates follow that Project alone. A
prompt that finishes is announced to the operating system: the `notifications`
bundle (desktopMain, since stage 10) reads the terminal event — `prompt.finished`, the one a client
acknowledges prompt completion by — into the Thread's name and the outcome
beside a bounded preview of the answer, unless the reader is already looking at
that Thread in a focused window, and the main process draws that as a native
notification, bounded again on both of its lines and dropped in silence where
the platform supports none, so a missing notice never hides a completion the
Thread's own log still states.
The macOS workspace window retains always-visible native traffic lights over a
renderer-owned draggable title bar. Splash, native theme, renderer, Monaco and
notifications follow the system light or dark preference, including changes
while a window is open. The compact, resizable shadcn sidebar stacks two
groups behind a draggable divider: the selected Project's recursive Threads
under a Threads label and an add action, and whatever other bundles contribute
through the layout's `layout.sidebar` region — today the `screen` bundle's
views, each row carrying that view's state. A region with no items leaves the
Threads group the whole sidebar and the divider inert. Neither the sidebar nor
a group has a separate header or collapse button. Threads start open over their
children and retain their independent expansion state. The sidebar supports
inline create and rename and context actions for child creation,
lifecycle-aware delete, and copying Thread IDs. Projects retain the color the
host assigns from a fixed palette; their navigation and actions live in the
Project tabs and Dashboard.
The tree uses the Papermache UI's regular font weight. A running Thread's name uses shadcn's shimmer,
and its add-action position shows elapsed execution time until hover or keyboard
focus reveals the add button. Once complete, the last execution's duration is
available in the row's hover title. Thread reads derive timing from the latest
durable `prompt.started` event and its matching materialized result; the initial
running-state update uses its transition timestamp until that event exists.
Creation starts as a focused local draft: an empty submission stays in place,
while blur discards it without an API call. The draft row wears the mark the
entity will wear — the Project's color mark, empty until the host assigns it,
and a Thread's message icon, or the Git or GitHub icon once the host marks the
Thread's working directory as a repository — never a generic file icon.
Selecting a root Thread opens its durable event-derived conversation on the left,
with no conversation header. Opening a subthread from the tree or a conversation
link opens a reusable workspace tab on the right, preserving the current main
Thread in the same Project. A direct subthread route first establishes its root
conversation on the left. The subthread tab contains its history, composer and
send/pause/queue controls, scoped to that Thread; composer signals and send requests
are isolated by Thread so simultaneous conversations cannot send each other's draft.
Transcript synchronization does not enter the editor's undo history. User edits
retain at most 50 undo entries per conversation, bounding retained editor states.
Switching tabs preserves the mounted conversation. Closing its tab only closes
the view, without terminating or deleting the Thread. Renames update the tab title;
deleting the Thread removes its tab after the Project tree confirms removal.
The app keeps a best-effort
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
tool calls or comments. Delegated inputs render as read-only Markdown blocks:
parent instructions and child results name their sending Thread, link to it
when it is in the loaded tree, and fall back to its short ID otherwise. Results
retain the recorded terminal status; an empty body has an explicit placeholder.
These blocks never wear the human reader's author line, and replay uses the same
durable inputs as live rendering. Parent instructions and child results share a
settled collapsible widget: parent instructions start open and child results start
closed, with an 18-pixel agent icon,
`Instruction from: "<Thread title>"` or `Result from: "<Thread title>"`, and a
chevron. The prefix never wraps, and long titles truncate with an ellipsis.
The title navigates independently of the toggle. Opening reveals the recorded
status and read-only Markdown. Mouse and keyboard share the node's open state,
which survives transcript updates.
The packaged CSP permits downloaded fonts from `self` only. App surfaces use
the macOS system sans stack with vendored Noto Sans as fallback, while the
conversation body uses vendored IBM Plex Mono. The sidebar
tree follows the selected Project's live
subscription, so a
Thread created by an agent appears without a manual refresh. The selected Thread
persists through the Electron window path across app restarts. Home is `/`, the
full Project list is `/projects`, a Project view is `/projects/:projectId`, and
direct Thread routes remain available. A fixed Dashboard tab opens `/projects`
directly; the all-Projects sidebar has no Doric avatar or brand heading. Locally saved
Project tabs remember their list view, order and last path. Their navigation
subscription stays stable across renders and is disposed on unmount; observing
the same route again does not replace their state. The fixed 40-pixel
top bar uses the panel surface (#2a2a2a in dark mode) and follows Papermache's
compact pill tabs: Dashboard stays pinned, the active
tab has a subtly raised neutral control surface. Project tabs show the Project's
colored avatar, with neutral backgrounds and no shadows or colored border.
Project and resource tabs share their compact typography, spacing and active
surface. Both strips scroll horizontally with the trackpad or mouse wheel,
hide their scrollbars and reveal the selected tab after selection, reordering
or resizing.
They support animated pointer and keyboard sorting and inline rename
through the host, retaining the saved title until confirmation. The macOS
traffic-light inset is released in fullscreen through the existing chrome event.
The tab bar's plus button alone opens Papermache's centered new-page layout
with actions, search and a recent list, without automatically opening the create
form. This is transient view state: startup and reload show the full Project list
even if the saved route is `/`. The Projects sidebar has no Home link, and closing
the last active Project tab returns to `/projects`. `/projects` uses its Finder layout with a 240-pixel navigation
sidebar, a fixed list view without a view selector and the same Project actions.
Project list and recent rows place the colored avatar beside the name without
a thumbnail preview. Color selection, clearing the color and deletion live in
the row's context menu; there is no ellipsis action button.
The Projects heading has 32 pixels of top padding and its list content has 48;
previously saved grid preferences do not change this view. Opening a Project
without an explicit Thread selects the first available Thread after its tree
loads. Returning to a Project tab preserves its remembered Thread path. Creating
a Project in the desktop also creates an initial unnamed Thread and opens it
selected. Its stored name is empty and the tree displays Untitled until rename.
If that Thread creation fails after the Project was saved, the desktop opens the
saved Project and reports the failure without resubmitting Project creation. One
full-height resize handle owns the sidebar boundary, and a second vertical one
divides the sidebar's own groups inside it; the sidebar stays expanded and
neither handle draws a grip of its own. A segmented
footer shares that geometry: the sidebar side shows the Electron main process's
Socket.IO connection status, while the content side carries the execution picker
— the model a prompt is sent to and its reasoning effort — beside the
settings trigger. The conversation footer combines the selected Thread's working
directory and branch in one popover trigger, without a Git icon. An adjacent
added/removed line-count button opens the right panel's Changes tab for the current
directory; counts share its lightweight status query even while the panel is closed.
The footer shows the full CWD, a middle dot and the branch, truncating the path
when needed. Its compact popover identifies the current worktree root and main
versus linked worktrees, with a copy-path action and no manual CWD editing.
The branch row opens a second lateral popover, keeping the summary open. It lists
existing local branches with search, commit summaries and worktree occupancy in a
shadcn Command and ScrollArea. Selection and Escape close only the branch popover.
While the selected Thread is running, its branch trigger and any already-open
branch choices are disabled. The picker does not render a blocking-message banner;
the host still rejects unsafe switches.
Conversation streaming preserves focus and selection in external controls; transcript
updates do not restore the editor's DOM selection while a popover or another input
owns focus.
The Conversation Trail uses base widths of 10 pixels for accepted user prompts and
grouped queued receipts, and 12 pixels for subthread results. Inactive queued
handles use a subtle primary tint distinct from ordinary prompts; every active
handle uses the full primary color, including during hover. Block handles
follow transcript order and jump instantly to place their block's top at 40%
of the conversation viewport where scroll range permits; the first and last
blocks stop at the available scroll edges. A clicked block handle stays
active until the reader scrolls manually, even when an edge prevents
exact alignment. Clicking a trail handle briefly fills its destination with a
neutral hover-like background, which fades by CSS transition to a subtle tint;
manual scrolling or hovering the highlighted block clears that tint. Passive
visibility changes never trigger this effect. Parent instructions and unsent
drafts have no handle. Trail
previews identify user prompts with the
reader's avatar and subthread results with the agent's bot icon and name. A
result preview also names its child Thread and links to it when that Thread is
still in the loaded tree, with an open-tab icon; otherwise it shows the short ID.
Hovering a handle makes it 17 pixels wide regardless of type, while its two
nearest neighbors step up in width and brightness. The cascade changes only the
handles and ends when the pointer leaves the handle. The visible block's
primary-color highlight remains independent. A subthread result takes the
highlight as soon as it enters the visible conversation, even when it is too
short to reach the viewport's top.
Conversation scrolling rests at the end of the scrollable content: the surface
opens with the caret in the prompt and the view at the end, and the trail's
Prompt Input handle goes to the end. Opening or choosing that handle keeps the
view at the end while the transcript loads and grows, including late layout
changes, until the reader scrolls away. A reader who scrolled away keeps the
same visible content while later turns arrive; scrolling back within 32 pixels
of the end resumes following. Choosing another trail handle stops following
the end.
The host lists and switches branches through semantic Thread REST and IPC operations.
Switching never forces checkout, stashes, creates a branch or fetches remotes; occupied
branches, conflicts and in-progress Git operations are refused. Active prompts or
terminal commands in the same worktree block switching under the Project mutation
queue. A successful switch revalidates Git summaries, files and comparisons together;
failures use toasts. The popover retains ahead/behind, dirty and operation details.
The Project tab bar is the workspace's only top header. Its right side hosts
the New terminal action followed by Files/Changes tabs. These tabs use the
standard shadcn Toggle with only an icon and an accessible name, with only
the active view pressed. Changes shows 12-pixel, regular-weight added/removed
counts only when at least one line was added or removed. The
conversation has no breadcrumb or title header.

A Project-scoped sandbox surface sits in a resizable right-hand panel that starts
open. It has no header or hide button; selecting a compact panel tab in the
Project tab bar also reopens the panel if it was collapsed by resizing. It reads the selected
Project's one sandbox, but roots its tree at the selected Thread's working
directory rather than at the workspace root, so selecting another Thread
re-roots what it shows while the sandbox it reads stays the Project's, and it
only reads: a Files tab shows that working directory's whole directory tree,
read in one request, with semantic Git colors and status letters on changed files
and descendant-change counts on folders. Ancestor folders inherit their descendants'
Git color; mixed statuses use modified yellow, while conflicts take priority.
A Changes tab shows changed files as
a directory tree grouped by repository, with individual folder expansion and no
search or collapse-all toolbar. Its tab shows total added and removed lines, and
each repository is the same tree row Files draws — a row that expands like a
directory, carrying its branch icon and its totals in green and red as that
row's own badge, with its changed paths nested under it as the same file rows.
Counts compare HEAD with working content (or empty with new files), include
untracked files and omit binary line counts. Git numstat supplies these totals
without sending file contents or patches to the renderer.
Both trees share a lightweight Git status read, separate from file comparisons.
Status preserves staged and unstaged changes, conflicts, and rename origins;
NUL-delimited Git output preserves special characters in file names. The tabs sit in the
Project tab bar's right side. The panel's footer carries the hardware
monitor and shares the conversation footer's height. The monitor reports the
selected Project's sandbox — the container's own CPU against the cores it was
given and its memory against its cgroup limit — beside the machine Doric runs
on, which the host process reads from its own kernel. It polls every three
seconds and has no manual refresh button. A reading a failed poll could not
replace stays on screen as the last one taken, so the surface never blanks or
flickers, and no failure it sees becomes a toast. Only the value that crossed a
threshold wears the theme's warning tone: memory at 85 percent of its limit, or
CPU sustained at 90 percent. The sandbox half answers the lease states every
Project subresource answers — still being acquired, unavailable in this provider,
or unknown — while the machine half depends on no lease. Working-directory,
branch and changes controls appear only in the conversation footer.
Selecting a file opens a resizable division between the
conversation and sandbox panel. This division keeps multiple tabs per Thread,
mixing files, individual Git comparisons, both agent and manual terminals, and
subthread conversations; opening the same item selects its existing
tab, and closing the last tab removes the division. A file tab's footer states
the chain the file was reached through. The division extends into the main
40-pixel header: Project tabs remain on its left, while file, diff, terminal and subthread
tabs occupy its right side before the terminal and Files/Changes controls.
The header seam follows the content division when resized, including dragging
the seam within the header. There is no second tab bar inside the viewer.
Its tabs use the Project tabs' 28-pixel neutral pills, 12-pixel medium labels,
6-pixel corners and subtle active shadow. Horizontal overflow has no visible
scrollbar. Tabs can be reordered within their own bar by dragging or
Alt+Shift+Left/Right; workspace order belongs to the Thread. Reordering and
switching tabs preserve mounted editors and terminal sessions. The close control
is subdued until hover; middle-click also closes a tab.
Reduced-motion preferences disable these transitions.
Tab sorting uses dnd-kit with a six-pixel pointer activation threshold, horizontal
movement, animated insertion previews and automatic scrolling at the bar's edges.
Tab and close-button widths remain fixed during a drag. Dropping commits the order;
Escape cancels it. Space starts keyboard sorting, arrows move and Space or Enter
confirms. Each tab bar owns its sorting context.
Long file-footer paths collapse their middle behind one trigger. File text is
rendered read-only by the Monaco editor
bundled with the editor worker alone. Because the whole tree arrives in one
read, expanding a directory reads nothing and is pure view state; only a file's
content or comparison is read on demand. Selecting a changed file opens a read-only
Monaco comparison of HEAD and the working file, unified by default with a single
line-number gutter, with an optional
side-by-side layout, change navigation, line counts, and an action to open the
working file. Monaco's icon font is bundled locally with the editor for its
change indicators. Comparisons use one compact toolbar with the tree's status
letters and colors, line counts and an always-visible open-file icon.
Comparison metadata and partial-read notices live in tooltips.
The comparison footer shows the file path with the same geometry as file tabs,
alongside icon controls for unified/split layout and previous/next change.
New files compare against empty content, deleted files against an
empty working side, and renames use the original HEAD path. Binary and truncated
reads explain their limitations. The
sandbox belongs to the Project and may not be usable at all: a queued,
failed or terminated Project explains itself — with the host's own retry hint
when the lease is pending — instead of erroring. One renderer coordinator
revalidates a Project's tree, lightweight Git status, open comparisons and files, and cached Thread Git
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
delays. Read failures appear as deduplicated Sonner toasts with a retry action
and clear after success, without inserting error cards into the tree or editor.
The panel header carries no updating label. Initial reads use skeleton rows
matching the tree's indentation, icons and row heights; the Changes skeleton
reserves a repository row of the same geometry, with its totals, and nests the
rows it shows one level deeper beneath it.
Background refresh preserves cached content and the reader's position instead
of replacing it with a loading placeholder; directory expansion is retained per
Project and working directory, together with the change tree's collapsed folders
without a search filter. Browsing either tree requests no full-workspace patch.

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
right of the Project tab bar creates a manual shell in the selected Thread's
working directory and opens it in the workspace section beside the conversation,
alongside files and diffs. Manual terminals have no separate bottom section.
The workspace preserves their emulators while switching tabs. Closing a tab
leaves the process running, and its sidebar row reopens it;
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

The left sidebar's screens group — the layout's `layout.sidebar` region, below
the Threads tree — lists the screens the reader spawned, and clicking one opens
or focuses a real window of its own: an Electron `BaseWindow` whose single
`WebContentsView` loads the sandbox's xpra HTML5 client in its own session
partition, drawing the native title bar and controls, a page and nothing else —
no preload, no bundle contracts, no frame. The row carries that view's state
(working on it, ready with its display, unavailable with its reason, or a
retryable failure) and retries while a sandbox starts. The `screen` bundle's
host part provides `screen.sessions/v2`: `attach(projectId)` runs on the
Project's runtime lease, ensures one xpra server inside the Project sandbox
(`:100` and up, ports `14500`–`14502`, a `/tmp/doric-screen.json` marker that
reuses the same display, port and token after a host restart) and answers the
host-relative path (`/screen/<token>/`) of that screen; its relay is served on
the host's own origin — mounted on the request router the bundles share and on
the host's `http.Server` for the upgrade, which is why an engine that also owns
that listener must not end upgrades it does not recognise — and forwards that
token tree to the sandbox's xpra server only, assets over HTTP and the live
stream over a transparent WebSocket that keeps the browser's own handshake, so
negotiated subprotocols and frames reach xpra unchanged; an image without xpra
answers `unavailable` with `missing-xpra`. The views persist across restarts,
the desktop owns their windows, and while a window is open the desktop keeps
asking the host for that screen and re-points the window at the path it
answers, so a screen that moved is followed rather than lost. One Project has
one screen, shared by its Threads, and two views of one Project are two windows
onto it.

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
model that lists efforts starts at its catalog default when that effort is not
`none`, or its first available effort other than `none` otherwise. The renderer
keeps reasoning enabled whenever the model offers it, including when it loads an
older configuration saved with `none`; the host still accepts an off effort.
The execution model popover keeps one Reasoning effort selector visible for every
selected model. A model without reasoning shows that button disabled and marked
unavailable. The model list and selector share the compact bordered popover
styling used for conversation costs, with the selector in a shaded footer. Its
effort menu and the footer's effort menu use compact rows, a subtle highlight
for the selected level, and the same bordered surface.
A credential is named and has one of a set of kinds that fixes its fields: the
built-in `API_TOKEN` is authentication, which a provider key and the GitHub token
both are; `USERNAME_PASSWORD` is authentication with a name; and the kinds a
bundle registers are added to that set. `GIT`, registered by the `git` bundle, is
identity alone, the username and email the agent's git commands commit with,
which is why it holds no secret at all. A secret is write-only: the host answers whether a
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
`PATCH /threads/:id`; both reach one rule, which refuses any path that resolves
outside the workspace root. The
existing sandbox-pool capacity governs Projects, not Threads.

The migration replaces the Session-facing APIs and clients without legacy
compatibility adapters. Creating a Project and creating a Thread are separate
operations: new Projects start without a conversation. Before 1.0, approved
schema changes may be consolidated into one clean Project/Thread baseline
without data-conversion or incremental-migration guarantees. Incompatible
legacy development databases must be explicitly recreated; neither startup nor
migrations silently reset an existing database.

The Project/Thread implementation replaces the former Session contract.
Its current architecture is defined here and implemented in `app/backend/doric-host`;
the host's public API and persistence details are documented in
`app/backend/doric-host/README.md`.

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

The Direct executor and its system prompt live in `/bundles/runtime/direct`; the
former one-module-per-coordination-tool set ships in `/bundles/features/threads`. The
system prompt file exports only one constant literal template string; dynamic
bundle skills are appended by the executor, not encoded as arrays of prompt
lines. Project and Thread lifecycle, queues, the prompt runner and the
prompt-scoped host facade live in `/bundles/runtime/runtime`; REST routes, Socket.IO
namespaces, HTTP errors and safe event serialization live in
`/bundles/foundation/transport`, which registers them on the native listeners through
`doric.network/v1`. The configuration and its `PUT /config` pipeline live in
`/bundles/foundation/host-config`, the database connection in `/bundles/foundation/postgres`, and the
Project and Thread handover in `/bundles/runtime/runtime/src/host`.
`app/backend/doric-host/src` is the kernel: it reads the composition, applies its
alternatives, checks the composition's `required` block, owns the native HTTP
and Socket.IO listeners and the generic desktop bridge, runs the platform's
start and stop hooks and binds the port. It names no bundle contract.

### Platform Boundary

The platform installs bundles, composes providers, routes calls, and runs
processes, windows, and IPC. It never knows a bundle's concepts (Project,
Thread, prompt, queue, Git, settings) or their methods and storage formats, and
a field of a generic schema that names one is a leak. The platform is
`packages/bundle`, `packages/storage`, `packages/desktop`, `app/desktop/doric`,
`app/desktop/doric-renderer`, `app/desktop/doric-platform`, and the kernel `app/backend/doric-host`.
Bundles reach one another only through published contracts; a bundle may import
another bundle's `<id>/contracts` entrypoint, never its source.

The mechanisms the platform provides, by name:

- **Call scope.** `CallScope` is an opaque record of bounded string keys:
  `callScopeSchema` accepts keys matching `scopeKeyPattern`, at most
  `SCOPE_MAX_KEYS` (16) of them, each value at most `SCOPE_MAX_VALUE` (512)
  characters. `windowKey` is platform-owned: only the main process injects it,
  a window may not send it in any spelling, and a bundle-supplied one is
  stripped. A bundle's scope keys belong to the bundle; `runtime/contracts`
  exports `runtimeScope` and `readRuntimeScope` for the Project, Thread and
  prompt keys.
- **Work holds.** A call pinned to a generation holds a `WorkHold {key, label?}`
  owned by its calling bundle, taken from the call's caller and never from the
  input. The process manager counts work holds and window holds apart, a drain
  waits only for work holds, and a lost generation reports its holds to each
  owning bundle.
- **Lifecycle hooks.** `doric.app.hooks/v1` has `onHostStartHook` (sequence,
  activation order, a failure is fatal, before `onHostReadyHook`),
  `onHostStopHook` (sequence, reverse order, after the listener closes),
  `onGenerationChangedHook` (`activated`, `draining`, `lost` or `stopped`, with
  the live generations and only the receiving bundle's own holds), and
  `onPeerSignalHook`, which delivers a `doric.generation/v1.signal(topic,
payload)` to the same bundle in every other live generation. The kernel names
  no bundle contract in these hooks; a bundle decides what they mean.
- **Startup records.** `doric.startup/v1` gives a bundle `stage(name)` and
  `log(level, fields, message)`, which the kernel's startup record uses; the
  kernel names only its own stages.
- **Composition data.** `composition.json` may name `resident` (installed
  bundles that run in the native host process rather than in a generation),
  `required` (the contracts and bundles the host refuses to serve without;
  absent, nothing is required), and `alternatives` (a choice between bundles
  that fill one role, made by the variable each alternative names; the shipped
  one is `sandbox`). The kernel reads these generically.
- **Optional contracts.** A manifest's `optional` lists contract IDs a bundle may
  call on a best-effort basis without an activation dependency. A call to a
  contract with no active provider keeps the caller's own unavailable behavior;
  the transport's feature reads are the example.
- **Native handles.** `doric.network/v1.register(listener)` gives a resident
  bundle the host's native HTTP and Socket.IO handles plus the `http.Server`
  both are attached to — where a bundle serves a protocol the request router
  cannot express, a WebSocket upgrade — locally and never serialized; the
  listener's cleanup runs when the bundle deactivates. The
  kernel owns the listener and the generic `/doric/bridge` bridge, and the
  `transport` bundle registers every product route and namespace through it.
- **Event sinks.** `events/v1` has one sink per provider, registered with
  `sink({scopeKeys, stream})`. The stream is a template over the scope keys the
  sink names; an append whose call scope lacks one is refused with
  `invalid_scope`. The core knows no Thread key.
- **Credential kinds.** `secrets/v1.registerKind` adds a kind to the built-in
  `API_TOKEN` and `USERNAME_PASSWORD`. A kind name matches
  `^[A-Z][A-Z0-9_]{1,31}$`, and a duplicate is refused with
  `duplicate_credential_kind`. `git` registers `GIT`, with username and email and
  no secret.
- **Desktop exposure.** The default is deny. A method reaches a desktop window
  only when it declares `expose: 'desktop'`: a platform contract declares it on
  its `MethodSpec` in `packages/bundle`, and a provider declares it in
  `x-doric-expose` of its contract document. A
  provider names the scope keys a window may send for it in `desktopScope` in its
  manifest, and any other key is refused. A contract with no active provider is
  unavailable. The exposed set is pinned by a permanent snapshot test,
  `app/backend/doric-host/tests/bridge-exposure.snapshot.json`, so a change to what
  windows may reach is an explicit change in review.
- **Windows.** A window descriptor names one of two contents: an app route
  (`path`) the window's shell renders, or a page on the host (`view`, naming the
  path main resolves against the host origin and the session partition the
  page's own `WebContents` keeps to itself). `doric.windows/v1` focuses a key's
  window and, since 1.1.0, navigates a view window to another host path. A
  descriptor may also set `primary`: the main process accepts
  one primary window per catalog and refuses a primary request for an already
  open window that was opened without the flag, with `registration_conflict`.
  The core marks `workspace` primary. The platform has no `openSettings()`; a
  command runs by id through `commands/v1`.

Client reads and UI that name a bundle's concept belong to that bundle.
`packages/desktop/reads` and `packages/desktop/ui` hold only generic primitives
(refresh queues, path utilities, tree and panel components, tokens).

### Current Runtime

Migration stage 1 of `docs/architecture/bundles/migration.md` ("Contrato") and
stages 2 and 3 ("Storage" and "Protocolo genérico", implemented together) are
implemented; the binding choices they made are recorded in
`docs/architecture/bundles/implementation-decisions.md`. Repository-owned
bundles live as individual Nx packages immediately below `/bundles`, named by
their bundle ID (Nx projects `bundle-<id>`); each owns its package metadata, a
v1 `manifest.json`, a TypeScript build to `bundles/<id>/dist` and a public
`<id>/contracts` entrypoint. The bundle build CLI of `packages/bundle`
validates the manifest and skills, dry-activates the host part to write the
contract descriptor (`dist/contracts.json`) and per-contract JSON Schemas; it
does not compare them with any baseline: no `contracts.published.json` is
committed, and the `baseline` command and its Nx targets are removed until
publishing (stage 11) compares against the registry. `doric-host:build-bundles` then stages each `dist` into
`app/backend/doric-host/dist/bundles/<id>`.

`/bundles/foundation/core` is the composition's core. Its host part provides the basic
contracts `hooks/v1`, `log/v1`, `tools/v1`, `skills/v1`, `settings/v1`,
`secrets/v1`, `storage/v1` and `events/v1` of `bundle/contracts`, and it
requires `storage.backend/v1` and `secrets.backend/v1`, which the composition
must choose in `providers`: hooks run in catalog order, the platform first, each
handler bounded by a 10-second deadline and every handler failure or timeout
reported to diagnostics; log records name the calling bundle, its version,
generation, call scope, trace and environment, have every stored or added
credential secret replaced with `[REDACTED]` in the message and the string
fields, and reach the host's pino destinations through the platform's
`doric.log/v1`; tools and skills are kept in bundle order with globally unique
names, and skill `allowed-tools` resolve against the whole `tools/v1` catalog after
activation. The other four are facades over the chosen backends. `storage/v1`
lets a bundle define the storage types its namespace names and lists in
`provides`, validates every write against the type's schema, lets only the
owner read or write a type and only the bundle a stream's first segment names
(or the active `events/v1` provider) read or write the stream, refuses a batch
over the backend's limits before sending it, and declares a type to the backend
on its first use rather than at activation. `settings/v1` keeps each registered
space as a `core.settings/v1` document with its revision, the owner's contract
version, the write time and the global `core.settings-generation/v1` counter,
and runs subscribers after each commit, before the next queued write.
`secrets/v1` caches the backend's credentials on first load (backend name
order, then `localeCompare` after each save), applies the shared credential
field rules to the built-in kinds and to any kind a bundle adds with
`registerKind` (the `git` bundle adds `GIT`), resolves by id or by kind, keeps
the redaction set, and answers
`referenced` to a delete while a registered reference source names the
credential; `settings.set` and the secrets writes share one write queue, which
replaces the foreign keys that used to protect referenced credentials and
assumes, as the credential cache already did, one host process per database.
`events/v1` appends a registered event's envelope, redacted and made storable,
to the stream its one sink names. The owner registers that sink with `sink({
scopeKeys, stream })`, so the core keeps no Thread, Project or prompt key: an
append whose call scope lacks a key the sink names is refused with
`invalid_scope`. The `runtime` registers `projectId`, `threadId` and `promptId`
with the stream `runtime.thread.events/{threadId}`, registers only
`runtime.prompt-finished/v1`, and writes the Thread events it owns to that
stream directly, in the same commit as the Thread document; REST and Socket.IO
serve the stream. `/bundles/features/files` owns the built-in `cwd`,
`edit`, `find`, `grep`, `terminal`, `tree`, `web`, and `write` tools; the `cwd` tool reports the calling Thread's
working directory and moves it, and a relative path a tool is given resolves
against that directory rather than the workspace root, exactly as `cd`
resolves one against the current directory; a move that resolves outside the
workspace root changes nothing. `/bundles/features/git` owns the routable `git` tool
plus focused skills for cloning, commit preparation, conflict resolution,
rebasing, remote synchronization, and linked worktrees. The Git tool executes
structured argv directly without shell interpretation, forces non-interactive
Git behavior, bounds stdout and stderr, and exposes no dedicated credential
input. `/bundles/features/threads` owns the delegation tools `thread-spawn`,
`thread-list`, `thread-get`, `thread-events`, `thread-send`,
`thread-interrupt`, and `thread-terminate` plus focused delegation,
inspection, and steering skills. `/bundles/features/terminal` owns `terminal/v1` and the `terminal` tool, as stage 10
describes below. Migration stages 5 to 7 are described below.

`/bundles/foundation/postgres` is the foundation bundle the composition chooses for
`storage.backend/v1` and `secrets.backend/v1`, so it activates before the core.
It owns the Prisma ORM 7 schema, the versioned migrations and the generated
client (`bundles/foundation/postgres/prisma` and the git-ignored `src/generated/prisma`)
and the process's single PostgreSQL client, which it creates on first use from
`DORIC_DATABASE_URL` and disconnects when it deactivates; neither it nor the
core performs I/O during activation. Its `storage.backend/v1` keeps the generic
primitives in `storage_*` tables: versioned documents with declared equality
and ordered indexes, streams with sequences, truncation marks and whole-stream
removal, atomic declarative commits applied as expect, delete, put,
dropStreams, truncate and append, a gapless commit feed in commit order, blobs,
health, and the reserved `hostId`/`storageGeneration` identity row that the
catalog publishes. Its health measures the filesystem at `DORIC_STORAGE_PATH`
without a database round trip and leaves the low-storage policy to the caller.
Its `secrets.backend/v1` keeps the `credential` table, which no other table
references, sealing each secret in the AES-256-GCM envelope under
`DORIC_CREDENTIAL_KEY` and reading existing envelopes without rewriting them.
The provisional local contract `postgres.database/v1` keeps `connect`, which
the kernel calls at `database_client` and which refuses a database that still
holds legacy Project, Thread or event rows without the stage-7 migration
marker; `client` and the `postgres/prisma` subpath remain only for the frozen
stage-7 test oracle and leave with the later migration that drops the empty
legacy tables. `packages/storage` (npm
`storage`) is the protocol package for `storage.backend/v1`: the index-key
encoding (`null` < `false` < `true` < numbers < strings, strings bytewise in
UTF-8, ties by document id), query cursors, stream ids and batch limits, the
in-memory storage and secrets backends with an embedded `memory` foundation for
tests, and the `storage/conformance` kit that the memory backend and the
`postgres` backend both pass. Only backends and the core host part import it;
other bundles reach storage through `storage/v1`.

`packages/bundle` owns the bundle platform: the browser-safe `bundle/contracts`
API (`define*`, `ref`, `Call`, `ContractError`, `Services`, the basic and
`doric.*` contracts), the shared service runtime `bundle/runtime`, the Node
loader (`startHost`), the build CLI and `bundle/testing`. At boot, in the same
`bundle_load` stage, Doric reads the installed bundles below
`DORIC_BUNDLES_PATH` (default: its staged `dist/bundles`) and the composition
JSON at `DORIC_COMPOSITION` (default: `app/backend/doric-host/composition.json`, which
names `core` and enables `transport`, `postgres`, `core`, `files`, `web`,
`git`, `threads`, `terminal`, `usage`, `resources`, `screen`, `runtime`,
`direct`,
`openai`, `openrouter`, `codex`, `docker`, `notifications`, `layout`,
`settings`, `chat` and `history`, and chooses
`postgres` for `storage.backend/v1` and `secrets.backend/v1`). Its `resident`
list names the installed host parts that run in the native host process rather
than in a generation process: `host-config`, which owns the configuration's
`settings/v1` space and provides `host-config/v1`, and `transport`, which
registers the REST and Socket.IO routes. Its `required` block names the
contracts and bundles the host refuses to serve without, and its `alternatives`
block names the sandbox choice that `DORIC_SANDBOX_PROVIDER` makes. A
composition that chooses no backend for either contract puts the host in
recovery, because the core requires them. The loader activates the foundation,
then the core, then the others in dependency order with lexical tie-break,
registers each bundle's `skills/*/SKILL.md` through `skills/v1` in lexical
folder order on the bundle's behalf, fires `doric.app.hooks/v1`'s
`onActivateHook` for every bundle activated after the hooks provider,
`onHostReadyHook` before the listener binds and `onDeactivateHook` in reverse
order at shutdown. A bundle that fails validation, dependency resolution or
activation, or whose tools or skills collide, is quarantined with reason codes
(`invalid_manifest`, `missing_dependency`, `activate_failed`, ...), logged as
`Bundle quarantined`, and dropped with its registrations while the others keep
serving; a core that cannot activate puts the host in recovery mode, which in
stage 1 ends in the existing fatal startup path after logging `Bundle recovery
mode` with every bundle's state and reasons. The catalog and diagnostics are
read through `doric.catalog/v1` and `doric.diagnostics/v1` (no HTTP route).
Doric reads the active generation's `tools/v1` and `skills/v1` for `GET /tools`
and for each prompt; `Bundles loaded`
reports the activated installed bundles (23 in the shipped composition; the
embedded ones are not counted) and the registered tools and skills. Because
activation opens no database, so the startup work runs in the start hooks.
`onHostStartHook` runs in activation order after the bundles load and the
composition's `required` block is checked, and before `onHostReadyHook`, which
the bundles hear before the listener binds. Each bundle names the stage it runs
through `doric.startup/v1`, and the kernel names only its own: `bootstrap`,
`bundle_load`, `network_binding` and `ready`. The shipped bundles name
`database_client` (`postgres` connects its client there, so a missing URL or an
unreachable database still fails), `credential_activation` (`core` loads the
credentials through `secrets/v1`, so a missing or malformed key or an
unreadable envelope still fails), `configuration_activation` (`host-config`),
`sandbox_pool` (`docker` or `firecracker`) and `workspace_reconciliation`
(`runtime`). At shutdown the kernel closes the server and sockets and runs
`onHostStopHook` in reverse activation order; the runtime's stop releases its
Projects, and the platform then deactivates the bundles, which closes the
generation (and its sandbox pool) and disconnects the database.
Migration stage 4 ("Processos de geração") implements the approved
multi-process scope of HC-003 for the host. The Doric process is the kernel: it
runs the foundation, the core, every embedded bundle, the bundles the composition
lists as `resident`, and the platform (catalog,
diagnostics, dispatcher, generation manager). The installed other bundles
(`files`, `git`, `threads`, from stage 5 `runtime` and `direct`, and from
stage 10 the feature, provider and sandbox bundles) activate in one Node `child_process.fork` per bundle
generation, through `startKernel` and the runner of `packages/bundle`, and the
two processes call each other's services through one RPC envelope; the tools
of those bundles execute in the generation process. Each call pinned to a generation holds a
`WorkHold {key, label?}` on it, owned by the calling bundle (the runtime keys
its holds by `projectId/threadId/promptId`), and that generation keeps its
tools and skills until the hold ends. A kernel-internal `publish` activates a
new generation, switches new calls to it and drains the old one until its holds
end, and the bundles hear about each change through `onGenerationChangedHook`
(`activated`, `draining`, `lost`, `stopped`, each filtered to the receiving
bundle's own holds) and `onPeerSignalHook`, so the kernel never calls a runtime
method; a change to the kernel partition is refused with
`kernel_restart_required`. The child ignores SIGINT and SIGTERM and exits when
the kernel disconnects. When a generation process crashes, its pending calls
fail with `generation_lost` and record no `tool.failed`; the holds it lost reach the
owning bundle through `onGenerationChangedHook` (`lost`), the runtime pauses
those prompts with `host_restarted`, its Threads hold their queues, and they
resume with the boot's attempt budget and order once the respawned process
(same generation number, next incarnation) or the active generation is ready.
After three failed starts the generation's bundles are quarantined with
`generation_failed` and the host keeps serving with an empty tool catalog.
There is no external trigger for a new generation, and stage 4 changed no
Prisma schema.

Migration stages 5 to 7 ("Runtime", "Executor" and "Dados") move the domain
out of the kernel; decisions D-S5-01 to D-S7-01 are indexed in
`implementation-decisions.md`. `/bundles/runtime/runtime` owns Projects, Threads,
queues, leases, recovery and the prompt runner through `runtime/v1`,
`runtime.threads/v1`, `runtime.workspace/v1`, `runtime.lease/v1`,
`runtime.terminals/v1` and `runtime.hooks/v1`. Stage 10 adds the local
`runtime.lease/v1.withLease` and `runtime.workspace/v1.withThread`, the
terminal result delivery on `runtime.threads/v1`, `onThreadsClosingHook` and
the unfilled `runtime.usage/v1.read`; the core adds
`models/v1.contextWindow` over `models.provider/v1.catalogCapacity` and the
`secrets/v1.watchRedactions` stream. It persists Projects, Threads and
histories as `runtime.project/v1`, `runtime.thread/v1` and
`runtime.history/v1` documents and each Thread's events in the
`runtime.thread.events/<threadId>` stream of `storage/v1`, folding the
`pending` queue projection and the usage aggregate into the same commit as
the event. `/bundles/runtime/direct` provides the local `executor/v1`, whose `run`
receives the runtime's `PromptSession`, and keeps its history as the opaque
`direct.history/v1` state (`messages` and `meta`). Its `compact` condenses an
idle Thread's history into one marked summary message: the automatic trigger
runs between provider turns of a run (after `usage`/`response.finished`, and
before a resumed run's first call) when the projected next call crosses the
configured `execution.contextCompaction` pressure, and `POST /threads/:id/compact`
condenses on demand. Both record the bracket events `compaction.started`,
`compaction.finished` and `compaction.failed` on the Thread log, using a
UUID prompt identifier compatible with event storage. The
finished event retains the exact summary message and its `summaryId`, so each
completed compaction node can expand to read and copy its own Markdown summary
after a shimmering `Compacting` row appears on `compaction.started` and updates
in place on completion or failure. The expansion icon sits immediately after
the completed row's label, on its right. The saved summary remains available
after later compactions. Legacy events without a saved summary show that it is
unavailable. A span containing only existing summary messages is refused as
`nothing_to_compact` before generation or event recording. The
desktop's manual compaction call allows five minutes for model generation;
usage reads and settings writes retain their ten-second deadlines. They rewrite
`messages` (plus the re-based `meta.checkpoints`) in one history-and-event
commit, so the log stays the full conversation and the summary never splits
an assistant tool call from its result. The core provides
`models/v1`; since stage 10 the `openai`, `openrouter` and `codex` bundles
register their `models.provider/v1` kinds and `docker` (or `firecracker`,
selected with `DORIC_SANDBOX_PROVIDER`) provides `sandbox/v1`; the stage-5
provisional `models-adapter` and `sandbox-adapter` bundles have been removed. The kernel
refuses to boot, at `bundle_load`, when a contract or bundle that the
composition's `required` block names has no active provider or is not active
(the shipped block names `runtime/v1`, `executor/v1`, `sandbox/v1`, `models/v1`,
`host-config/v1` and the `transport` bundle; an absent block requires nothing); when a structural provider is lost after boot (its
generation exhausted its respawns) the kernel logs `Bundle recovery mode` and
exits with code 1, as the process used to die. A kernel-internal `publish()`
hands Projects over between generations: each Project records its owning
generation and incarnation, the draining generation finishes the prompts it
runs and releases each idle Project (closing its live terminals), and the new
generation adopts it through its own handover (`onGenerationChangedHook`, and
the `runtime.released` peer signal of `onPeerSignalHook`), not through a kernel
call; Projects of a dead owner get the `host_restarted`
recovery. The sandbox-pool and `llms` debug lines are now written by the
generation through `log/v1` with a `bundleId`; the kernel writes `Doric
starting` and `Doric listening` with the composition's chosen `alternatives`
(for example `{ sandbox: "docker" }`), and the sandbox bundle writes its pool
line from its start hook through `doric.startup/v1`.
The `GET /resources` CPU sample runs in the transport (the kernel process) and
the `web` tool's `fetch` runs in the generation process, both on the host
machine as before. Stage 4's asynchronous `RemoteTool` check no longer runs
during prompts, since `direct` binds the local tools. Stage 7 is the first
lossless data migration of Projects, Threads, histories and events into the
runtime's documents and streams: it runs in one transaction under `prisma
migrate deploy`, verifies the copy, records the `runtime.migration/v1` marker
and deletes the legacy rows, keeps `storageGeneration`, is idempotent and
cannot be reversed in place, so operators back up the database first; the
empty legacy tables are dropped by a later migration.

Migration stage 8 ("Plataforma desktop") moves the desktop onto the bundle
platform; decisions S8-1 to S8-23 are recorded in `implementation-decisions.md`.
Every app window loads only `doric://app/<path>`, a privileged standard scheme whose
handler serves the shell, the platform files under `/platform/`, verified bundle
artifacts from the local cache and their schemas, and answers 404, never the
shell, for missing files; sender checks compare protocol `doric:` and host `app`
(S8-1). A view window loads the host's own origin instead and carries no
preload, so no sender check applies to it. In development the windows still open through `doric://app` and the
handler forwards the shell and its assets to the renderer dev server
(`http://localhost:4200`, overridden by `DORIC_RENDERER_DEV_URL`). Before any
window, a splash downloads the host's `doric.catalog/v1.distribution()` over the
host bridge Socket.IO namespace `/doric/bridge`, verifies each artifact's
SHA-256 and shows the recovery surface for quarantined bundles, unreachable
hosts and windows not ready within 30 seconds. Its "Disable" and "Return to
default composition" actions call the host's `doric.catalog/v1.disable` and
`resetComposition` (HR-6), which write or delete `composition.overrides.json`
(`{ "disabled": [...] }`) beside the active composition, never in the product
database, and publish a new generation; every host catalog read leaves the
disabled bundles out of `enabled`, and the core cannot be disabled. The main runs one Electron `utilityProcess`
per desktop generation, executing the core's `desktopMain` part, which opens
the window the core marks `primary` (the `workspace` key today) at the last path the main stored for that key
(`doric/windows.json`, paths only, no bounds). An allowed quit waits for pending
window-path and platform-state writes before exiting. The core defines the menu skeleton
without a Settings item or `Cmd+,`. One dispatcher routes window calls by
contract to the window, the `desktopMain` generation or the host; at stage 8 the
legacy Project, Thread, settings and terminal IPC channels remained beside it
and the renderer was the shell's legacy React tree (both removed by stage 9);
the shared desktop package is `packages/desktop`: `desktop/ui` supplies tokens,
theme, fonts and shadcn/ui components; `desktop/client` runs the window;
`desktop/reads` supplies generic read helpers; and `desktop/protocol` names the
window-main API. `app/desktop/doric-platform` builds the platform files and import map.
The CSP adds `worker-src 'self'` and the import
map's script hash, and carves out no frame origin: no window frames a foreign
origin any more, so frames fall back to the default source. The renderer's local storage, including the selected Thread,
migrates once from the packaged `file://` origin to `doric://app`: the core's
`onAppReadyHook` asks the platform through `doric.migrations/v1.storage` to copy
its own key, and awaits the answer before it opens the primary window. The
platform owns both origins and the legacy and blank pages; a caller names only
the key and a marker, which the platform records in its state. A failed copy is
logged, its marker is still recorded, and the window opens anyway. Development
profiles do not migrate.

Migration stage 9 ("UI em bundles") moves the whole renderer UI into client
bundles; decisions D9-1 to D9-20 are recorded in `implementation-decisions.md`.
The composition enables `layout`, `settings`, `chat` and `history`. Every
window's shell calls `bootstrapWindow({})` and shows `<core-outlet>`; the core's
client part provides `ui/v1`, `navigation/v1` (routes are URL paths matched on
`pathname`), `regions/v1`, `commands/v1` and the outlet, region, not-found and
unavailable elements. `layout` registers `/` with the workspace frame, its
`layout.sidebar`, `layout.header` and `layout.footer` regions,
`layout.tabs/v1` and `layout.workspace/v1`, and kept the files, changes,
terminals, usage, resources, working-directory and branch UI under
`src/client/provisional/` until stage 10 moved them to their bundles; `chat` registers
`/projects/:projectId/threads/:threadId` (child of `/`) with `<chat-view>`, its
composer as a `layout.footer` item, and `chat.views/v1`, `chat.lexical/v1` and
`chat.hooks/v1`; `settings` registers `/settings` with sections as child routes
and the execution picker as a `layout.footer` item; `history` (desktopMain)
keeps the per-Thread snapshot cache over `doric.cache/v1`. The new platform
contracts are `doric.elements/v1`, `doric.connection/v1`, the transitional
client form of `doric.notifications/v1` and `doric.windows/v1`, whose focus and
`navigate` (1.1.0) re-point the window a key names. The
selected Thread is the window path; the old `localStorage['doric.selection']`
is converted once into a path and removed. The shell's stylesheet keeps only the
window-wide rules and the sorted utility set; each UI bundle ships its own
`client/styles.css`. The visible text, roles, layout and quirks of the stage-8
renderer are unchanged.
Stage 10 (WP-10P) adds minor versions for the feature bundles, with no visible
change: `layout.workspace/v1@1.1.0` (selection, a Project's Threads, the
connection, the `layout.main.bottom` split), `layout.tabs/v1@1.1.0` (trigger
icon, aria label and tooltip, closing in a named owner, the current tab), the
new `layout.panel/v1` (the Project panel over `layout.panel` region items, with
`layout.panel.header` and `layout.panel.footer`) and `layout.sidebar/v1` (rows
under each Thread), `chat.hooks/v1@1.1.0.onThreadUpdateHook`, a
`chat.delegated-input/v1` renderer slot and `<chat-readonly-markdown>`, and
`settings.config/v1` (the settings window's one autosave draft). The layout
imports the shared widgets from `desktop/ui/workspace` and `desktop/ui/code`.
`alwaysAvailable` (a `tools/v1` registration option and an optional skill
frontmatter key) is recorded and never consulted: every registered tool is
bound on every prompt, and Doric includes every canonical skill body in its
Direct system prompt in bundle order. `bundle/contracts` publicly owns the
JSON-Schema-compatible `SkillSchema`, whose input is normalized into a
canonical `SkillRecord` with trimmed fields, stable unique `allowedTools`, and
a recalculated `indexText`. `packages/tool` publicly owns `defineTool`, whose
`execute(payload, call, services)` receives the validated payload, the prompt
`Call` and the services of the bundle that registered it; registering the
definition with `tools/v1` binds it to those services, and `toTool(call)`
gives the agent-loop tool for one prompt. It also owns the
JSON-Schema-compatible `ToolDefinitionSchema`, whose runtime descriptors carry
both `inputSchema` and `outputSchema`, plus strict-output-compatible
`ToolMetadataSchema` and JSON value schemas used by structured consumers.
Tools expose Zod `input` and `output` schemas; handler results are
output-validated before execution resolves, with sanitized `invalid_output`
failures. Declared tool `settings` keep feeding `GET /tools` and configuration
validation; their values reach tools through `settings/v1` in a later stage.
Providers transmit only their supported tool fields and use `inputSchema` as
function parameters. Model-generated graph nodes use tool metadata rather than
executable tools or arbitrary tool input schemas.

Stage 10 ("Funcionalidades e sandbox", WP-10L host switch and WP-10N desktop
switch) moves each feature into its own bundle. The composition enables
`openai`, `openrouter` and `codex` (provider kinds come from their
`models.provider/v1` registrations; codex is resolvable but not advertised by
`GET /providers/kinds`), `docker` as the one `sandbox/v1` provider
(`firecracker` is staged; with no `DORIC_COMPOSITION`,
`DORIC_SANDBOX_PROVIDER=firecracker` boots the shipped composition with
`firecracker` in its place; the libraries are `docker-sandbox` and
`firecracker-sandbox`), `terminal`, `usage`, `resources` and `notifications`.
`files` (`files/v1`), `git` (`git.commands/v1`), `terminal` (`terminal/v1`),
`usage` (`usage/v1`) and `resources` (`resources/v1`) read the sandbox over
`runtime.lease/v1.withLease` and never acquire a lease; `usage/v1` also
exposes the footer's compaction controls (`compact`, `compactionTarget`,
`setCompactionTarget`: the manual compaction of one idle Thread through
`runtime.threads/v1.compact`, and the pressure line read from and moved on
the configuration in force). The context popover shows used tokens and capacity,
a single vertical drag handle at the compaction percentage on the full bar,
and a collapsible breakdown of used context, available space, capacity and
the compaction threshold. Unknown measurements stay unknown; the breakdown
does not infer per-category token counts. The `terminal` bundle
owns the `terminal` tool and closes a closing Thread's sessions through
`onThreadsClosingHook`. Tools and skills keep one global model-visible order
(`order` on `tools/v1` and `skills/v1`), and `allowed-tools` resolve against
the whole `tools/v1` catalog after activation. The `web` bundle owns the
`web` tool (700) and the `web-research` skill (1200); the old `web`
source and `12-web-research` skill have been removed from `files`. On the desktop, the layout draws no feature UI of
its own: the Files view is a `files` region item, the
Changes view, the footer's working directory and branch, the comparison tab
and the Versioning settings section (`/settings/git`, which replaces
`/settings/versioning`; the window still opens at `/settings`) are `git`'s,
the "New terminal" button, the sidebar terminal rows (`layout.sidebar/v1`
rows created through `ui/v1`) and workspace terminal tabs are `terminal`'s,
the footer's context and cost
are `usage`'s, and the resource monitor stays in the Project panel's footer
(`layout.panel.footer`) as `resources`'. The file tab keeps its own footer,
and diffs open as tabs. Prompt-completion notifications are decided in the
`notifications` bundle's desktopMain part from chat's `onThreadUpdateHook`
observations (the Thread name, the shown Thread and the window focus sampled
in the window at receive time), and shown by main's
`doric.notifications/v1`, again a desktopMain-only contract; chat's own
announcement, the client form of `doric.notifications/v1` and the
`doric.shell/v1.notify` call are gone. Feature bundle stylesheets also scan
the stage-9 window bundles' sources, so a shared class never lands after a
responsive variant of another sheet, and `desktop/ui/sidebar` exports
`SidebarScope`, the sidebar context alone, for an element that draws sidebar
rows from its own React root.

The `Host` capability facade the runtime's runner builds for every prompt is
the `runtime` bundle's own contract: its types live in
`bundles/runtime/runtime/src/contracts/tool-host` and are exported from `runtime/contracts`,
and the runner that builds them lives in `bundles/runtime/runtime`. The former
`packages/host` package is gone; it held only these types, and no other package
imported it. A `Host` is prompt-scoped; it closes over the calling
prompt's Project and Thread, so `host.threads.*` reaches only that prompt's
direct children and stops when the prompt ends, and `host.workspace.*` reports
and moves only that prompt's own Thread's working directory. Today's
namespaces are `threads`, `workspace`, and `terminals`; the latter starts
tracked foreground or background commands in the calling Thread's sandbox
without exposing other Threads' sessions. Background process ownership
survives completion of its originating prompt; future namespaces (`config`,
`vms`, `providers`) are added only for a concrete need, never as a state dump,
a leaked `ProjectRuntime` or Prisma row, or an `invoke` escape hatch. Bundle
tools no longer receive it as an argument: `/bundles/runtime/runtime` provides
`runtime.threads/v1`, `runtime.workspace/v1`, `runtime.lease/v1` and
`terminal/v1` by forwarding each call one to one to the `Host` and sandbox the
runner built for the prompt named by the call's scope, while that prompt runs; an ended prompt's
calls fail with `Thread control is no longer active.`, Host failures reach the
tool unchanged, `runtime.lease/v1` forwards no abort signal, and a prompt
without live terminals answers `unavailable`, which keeps the terminal tool's
plain-command fallback. Exposing these capabilities to every tool handler is
an approved tool-privilege expansion under HC-004 and HC-007: a bundle
previously reached only the sandbox. Because the contracts are reached by call
scope, any bundle that requires them and builds a scope naming a running
prompt reaches that prompt's controls; every stage-1 bundle is first-party and
external bundles remain deferred. Because a tool result goes to the model, the
contracts expose capabilities, never credential reads; secrets stay in the
host's credential store, and no shipped tool bundle requires `secrets/v1`.
Tool names stay globally unique in `tools/v1`, so a bundle tool cannot collide
with another bundle's.

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

The `host-config` bundle receives complete singleton configuration replacements
through `PUT /config`, which the `transport` bundle routes to it. It persists only provider IDs, the kind each provider is, the
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
which is why the stored effort is optional, so no prompt carries a reasoning
block the endpoint never offered.
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

The host's credential store is the `credential` table of the `postgres`
bundle's `secrets.backend/v1`, reached through the core's `secrets/v1`, whose
facade serves named rows of a closed kind set, where the kind fixes the field
set. `API_TOKEN` is authentication and the provider keys and GitHub token are
both ones; `USERNAME_PASSWORD` is authentication with a name; both are built
in. A bundle may add a kind with `secrets/v1.registerKind`: `git` adds `GIT`,
which is identity alone and therefore holds no secret. The one field rule,
`credentialFieldsSatisfied` in `bundle/contracts`, is what the `secrets/v1`
validation applies, so a value the kind forbids is rejected before it is
stored. A secret is stored as a versioned
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
identity again reattaches that Project's one running container and the same
files — across a host restart and the next lease for that Project; a stale
container of the same identity is removed, never duplicated. Reattachment
requires compatible image, resource, network, DNS and SSH settings; otherwise
the container is replaced while the named volume is kept. Failed duplicate
removal fails acquisition, and concurrent leases share one container with
idempotent release. `discardWorkspace` removes it when the
Project is deleted. A sandbox provisioned without a workspace binds nothing and
loses its files with the container, which is what the Firecracker profile still
does: its guest disks live under the per-run state directory. The durable volume
holds its files on the host's own storage, so a sandbox's `diskMiB` bounds only
the container's writable layer. It also owns the
one implementation of the workspace visibility rules — root confinement,
`.gitignore` handling with negation, hidden entries except `.agents`, and
directories-first ordering — which the `/bundles/features/files` `tree` tool and Doric's
Project file routes both consume, so neither can drift from the other; a scoped
diff is expressed through `SandboxDiffInput.paths` rather than by callers
building Git argv. Every sandbox has
explicit CPU, memory, and writable-layer disk resources; networking is disabled
by default, optional SSH is key-only and loopback-bound by default, and
effective egress requires IP-literal DNS. A sandbox holds no Docker socket by
default; `DORIC_SANDBOX_DOCKER_SOCKET=true` mounts the host daemon's socket
into every Docker sandbox, at `/var/run/docker.sock`, so its Docker CLI can
build and run the images a Project describes. That socket carries the daemon's
authority on the host, so the setting is for a local, trusted deployment rather
than the default. Doric provisions Docker sandboxes
with one CPU, 2048 MiB of memory, and a 4096 MiB writable layer; Firecracker
keeps its 512 MiB memory limit. Both providers answer `Sandbox.stats()` —
Docker from the daemon's own container statistics, Firecracker from its guest's
`/proc` — each normalized to the sandbox's own cores and memory limit, so an
observer sees what a sandbox is consuming without acquiring, restarting or
interrupting anything, and a provider that cannot measure leaves the reading
unknown instead of failing one. Both use the image named by
`DORIC_SANDBOX_IMAGE`, which defaults to the
multi-architecture `node:22-bookworm` image, with the `1.1.1.1` DNS resolver so
selected Git skills can reach public remotes. That default ships Git; the
sandbox image Doric builds from `app/backend/doric-host/.sandbox.Dockerfile` ships Git,
the GitHub CLI, Electron's runtime libraries, Xvfb and the xpra screen
server with its HTML5 client, the display stack a sandbox needs to build
a desktop app and serve its Project screen, and Docker's engine and CLI,
which build the images a Project describes given a daemon an operator exposes. The image is a deployment choice the host reads from its
environment rather than a compiled-in value, and Firecracker resolves an
anonymous public OCI image, so a locally built tag needs publishing, or the
variable pointed at a public image, before that provider can use it.
`DORIC_SANDBOX_SSH=true` adds loopback-bound, dynamically allocated
user SSH access so a trusted same-host user can inspect the active Project
sandbox. Native source runs default it off because provider SSH requires pinned
host assets; the Doric runtime image and Compose profiles default it on and
include those assets. Remote authentication remains runtime-provided and must
never be placed in model-visible tool arguments.

`packages/docker-sandbox` and `packages/firecracker-sandbox` (npm
`docker-sandbox` and `firecracker-sandbox`, renamed in stage 10 to free the
bundle IDs) depend inward on Sandbox and expose providers. The `docker` and
`firecracker` bundles each provide `sandbox/v1` over one of them, with the VM
registry from `sandbox` (`createVmRegistry`); the composition's `alternatives.sandbox`
enables only one. Docker is Doric's default; `DORIC_SANDBOX_PROVIDER=firecracker`
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

`app/backend/doric-host/.Dockerfile` reproducibly builds the agent and every built-in
bundle, pinned Firecracker and jailer, Linux 6.18 guest kernel, static BusyBox
and Dropbear bootstrap, initramfs, OCI/ext4 tooling, networking tools, and
OpenSSH client. Its Linux-only Compose profiles provide either the Docker
socket plus host-network firewall access or KVM/TUN/cgroup/state/cache access
without a Docker socket. The privileged Firecracker profile is a development
and e2e harness, not a production isolation boundary. Local deploy credentials,
including the PostgreSQL password, live only in the git-ignored
`app/backend/doric-host/.env` (see `app/backend/doric-host/.env.example`); they are never committed
or baked into the image. Doric acquires one pool
lease when each persisted Project is created and retains it across all its
Threads and prompts. It binds every bundle tool to that sandbox, propagates
cancellation through acquisition and active provider calls, and releases the
lease exactly once on termination, acquisition failure, or shutdown. Projects
have no automatic expiry and therefore occupy capacity until explicitly
terminated.

The kernel creates an otherwise unconfigured Express application and a
Socket.IO server on the same HTTP listener, and the `transport` bundle registers
every route and namespace on them through `doric.network/v1.register`. The
listener binds to
`DORIC_HOST` and `DORIC_PORT`, defaulting to `0.0.0.0:3000`; the Doric image
exposes port 3000. The transport's Express router exposes `GET /vms`, which returns
the IDs and selected provider names of runtimes successfully provisioned by
this Doric process and not yet successfully disposed. `GET /vms/:id/ssh`
returns the selected provider, owning live Project ID, and complete
`SandboxSshAccess` only while that VM is leased to an active Project;
idle, releasing, and disposed VMs never expose access. `GET /resources` reports
the machine the host process itself runs on, and `GET /projects/:id/resources`
reports the Project sandbox's own CPU and memory. The Project read answers the
same lease states as its other subresources and never acquires one, so observing
a sandbox cannot bring a Project up. The registry wraps the
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
REST additionally serves `GET/PUT /config` (through `host-config/v1`), the `/credentials` create, list,
patch, and delete surface,
named Project and Thread creation, rename through `PATCH`, cursor listing,
detail, FIFO prompt acceptance through `POST /threads/:id/prompt`, history
rewind through `POST /threads/:id/rewind`, ordered event
replay with an optional exclusive `afterSequence`, reader-controlled Thread queue pause,
idempotent termination, and terminal-only deletion. Each Thread turn records the
provider-history length it started from, so rewind truncates that history
exactly at a turn boundary, removes the edited turn and every later turn from
the durable event log, drops their checkpoints, and then accepts the edited text
as a normal human input. Rewind refuses while the Thread is running or has
queued input, so the FIFO queue never executes on truncated history. Project and
Thread names entered in the desktop
are trimmed, exclude NUL, and contain 1 to 80 Unicode code points. The runtime
Thread create contract also accepts an empty name, used by the desktop for a
new Project's initial unnamed Thread; manual creation and rename still require
a nonempty name. `/projects`
owns environments and `/threads` owns conversations; there are no `/sessions`
routes or compatibility aliases. Public Project and Thread list/detail
representations contain identity, name, state, ownership, timestamps,
applicable revision/sequence and sanitized error codes, not prompts, messages,
events, results, or SSH credentials.

The `transport` bundle serves separate Socket.IO `/status`, `/projects`, and `/threads` namespaces; the kernel's `/doric/bridge` namespace is the generic desktop bridge described under Platform Boundary.
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

The `postgres` bundle owns the Prisma ORM 7 schema, generated client
configuration, and versioned PostgreSQL migrations;
`app/backend/doric-host/prisma.config.ts` remains the compatible entry point that
Compose's migrate service, the image build and `nx run doric-host:migrate` use.
Production uses one adapter-pg Prisma client per process and never applies
migrations implicitly during HTTP startup. PostgreSQL stores the singleton
configuration as the `settings/v1` space `host-config.configuration/v1` (one
`core.settings/v1` document of the generic storage tables), the credential
store and, as `runtime` documents and streams of the generic storage tables,
Project names, colors and configuration snapshots, Thread names, parentage,
the Direct executor's provider-ready message history, and ordered Thread
events.
The generic-storage migration converts the former `doric_configuration`,
`provider_configuration` and `model_configuration` rows losslessly into that
document, keeping the configuration revision and update time so the next
replacement answers the next revision, verifies the conversion, and only then
drops those tables and the `ModelRole` enum; a stored provider kind outside
`openai`, `openrouter` and `codex` stops the migration instead of being
discarded or converted. It cannot be reversed, so operators back up the
database before applying it. The configuration has no foreign keys any more and
the `credential` table stands alone. The incremental registered-kind migration
converts its kind enum to text without changing IDs or encrypted secret bytes,
so bundle-defined kinds need no backend schema release. The `host-config` bundle refuses
a configuration that names a credential that is not stored and registers the
provider tokens, Git identity and GitHub token the stored configuration names as
references, so the core's `secrets/v1` refuses to delete them, exactly as the
former foreign keys did; a credential named only in the tool configuration is
still deletable. The credential
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
block the HTTP listener. Reader-paused Threads retain their durable dispatch gate:
neither pending inputs nor the interrupted prompt run until an explicit resume.
A record a crash left `cancelling` is completed to `cancelled` instead, so a
restart cannot revive work the reader terminated; events remain replayable.
Physical Thread deletion requires its entire subtree to be terminal; Project
deletion requires every Thread terminal and cascades to its Threads and events.
The local Compose surface pins PostgreSQL 18.4, mounts its PostgreSQL-18 volume
at `/var/lib/postgresql`, runs migrations as a one-shot dependency, and starts
either Doric sandbox profile only after the database is healthy and migrations
complete.
Doric startup emits safe structured `info` logs for its listener and sandbox
selection, sandbox limits, bundle resource counts, PostgreSQL client
initialization, active configuration revision and model profiles, Project/Thread
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

Doric advertises only OpenAI and OpenRouter in its provider catalog. OpenAI is
the Responses-compatible adapter with caller-configured identity and endpoint.
Codex remains available internally, including existing configuration, but is
excluded from the advertised catalog. LM Studio's native and Chat Completions
adapters, the separate OpenAI-compatible kind, and the raw OpenRouter public
adapter and Decisions API are removed. OpenRouter incorporates the former
Unified behavior and uses stable OpenRouter Chat Completions, a 15-minute live model
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
Configuration and execution use the same optional OpenRouter `modelsUrl`,
defaulting to `/models` below its configured endpoint. The provider consolidation
migration preserves provider ids, credentials, model selections and historical
snapshots while mapping `unified` to `openrouter` and `openai-compatible` to
`openai`; compatible rows pointing at the standard OpenRouter endpoint become
`openrouter`, including the bootstrap row. Existing LM Studio rows block the
migration with an explicit instruction to configure a supported replacement
using the previous app version. No credentials or configuration are silently
discarded. The repository OKF runner now uses Responses with `OKF_BASE_URL`
(default `http://localhost:1234/v1`) and optional `OKF_API_KEY`.
The opt-in paid OpenRouter conformance runner reserves stdout for its
final JSON report, permits up to 1,024 output tokens per request, and emits Pino
progress to stderr. Failures identify the exact structured-output, tool-call,
or tool-replay stage and expose the provider error fields retained by the LLM
boundary; the runner owns the decision to display those diagnostics. An empty
structured response diagnostic identifies its finish reason and available output/reasoning token
counts instead of returning an empty string.
The OpenAI and OpenRouter integrations support
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
relevance score. Codex supports neither embeddings nor
reranking.
`packages/llms` exposes its OpenAI Responses-compatible factory with
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
OpenAI, Codex, and OpenRouter send resolved effort through `reasoning.effort`.
The Codex provider uses the existing provider token
field for the Codex authorization value and derives Codex-compatible account
headers from that credential when available. OpenAI provider
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
`app/*/*`, `packages/*`, `tools/*`, `workflows/*`, `bundles/*/*`, and
`benchmarks/*`.

Use current manifests and source as the package inventory. Do not treat this
file as the source of truth for every package responsibility.

Durable boundaries:

- product packages live under `packages/*`;
- backend host and end-to-end tests live under `app/backend/*`;
- desktop applications, renderer, platform, and end-to-end tests live under `app/desktop/*`;
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
be persisted outside one explicitly approved place: the host's credential store
(the `postgres` bundle's `credential` table behind `secrets/v1`), which keeps
each secret as an AES-256-GCM envelope under `DORIC_CREDENTIAL_KEY`, answers
only whether one exists over the API, redacts it from events and logs, and
keeps it out of tool payloads. Prefer dependency injection and
explicit configuration objects for sensitive runtime inputs.

Doric Direct Thread replay is durable in PostgreSQL. Projects transition from
`queued` to `ready` after sandbox acquisition; Threads wait for their Project
and each FIFO input transitions `ready -> running -> ready`. Project and Thread
termination use `cancelling -> cancelled`; acquisition or reconciliation
failures use `failed`. A host stop is not a termination: it releases the lease and
writes the Project back as `queued` with its non-terminal Threads `ready`, pausing
the prompt that was running so the next boot takes it up again. Every boot
reconstructs all nonterminal Projects and schedules their sandbox acquisition —
the same durable workspace identity on Docker. Projects with owed prompts queue
first, followed by idle Projects in creation/id descending order. Acquisition
runs in the background within the pool's capacity; listener readiness never waits
for a lease. Repeated recovery and concurrent prompts share one Project runtime
and acquisition. Completed prompts are not rerun. A reader's own stop pauses the same way, and only the reader
takes that prompt up again; terminating a Project or Thread is the terminal act,
not stopping one. Reading a Project that holds no lease still answers
`pending`/`unavailable` and never acquires. Thread Git and branch reads also return
these as successful read states, so the app shows environment preparation and
polls pending reads without operation-error toasts. Mutations still require a
live lease. Terminal Projects remain terminal. Termination needs no live runtime: a
Thread whose Project holds no lease still takes itself and its subtree through
`cancelling -> cancelled` durably, so a reader can terminate and delete a resumed
Thread without prompting it first. A fresh Agent per prompt
receives a fresh tool-call store, every registered bundle tool bound to a
prompt `Call` scoped to that prompt (its sandbox and per-prompt host facade
attached to that scope for the run), the deterministic
all-skills system prompt, and
`createMessageStorage(...)` initialized from that Thread's exact persisted
provider-ready history. Success and failure both persist the resulting complete
or partial history, redacting configured credentials and replacing the
characters PostgreSQL refuses (U+0000 and unpaired surrogates, which binary tool
output can carry) with U+FFFD rather than failing the Thread. Provider/tool failures
return the Thread to `ready`. Storage pressure pauses execution instead of closing
the Thread: before dispatch and every three seconds during a run, the host reads
`storage/v1.health`, the `postgres` bundle's measurement of the filesystem at
`DORIC_STORAGE_PATH` (the current directory for native runs), which makes no
database round trip, and applies the policy itself.
At or below 10 percent available blocks, or if that check is unavailable, dispatch
stays paused until an explicit resume passes a fresh check. Compose mounts the
PostgreSQL volume read-only at that path so the measurement describes persistence,
not a sandbox layer; native or remote-database deployments must provide a path
on the actual database filesystem. PostgreSQL `53100` and OS `ENOSPC` errors use
the same nonterminal `storage_low` pause, preserving pending inputs. If even the
pause or checkpoint cannot be written, the live host keeps the gate closed and
retains its pending history and event in memory; resume flushes them before
dispatch. Those unsaved values cannot survive loss of the host process. Persisted
storage pauses and their queue error survive restart, never auto-resume and appear
as a queue alert and a transcript pause marker. Other history or event persistence
failures still fail the Thread closed rather than executing queued inputs on stale history. Acquisition
failure is terminal for the Project. Cancellation and lease cleanup continue
even if cancellation-state persistence fails.
Doric adds `history.truncated`, `prompt.accepted`, `prompt.queued`, `prompt.started`, `prompt.paused`,
`prompt.resumed`, `prompt.finished`,
`agent.failed`, and
`agent.cancelled` events around the Agent stream. `prompt.accepted` carries the
input text and its source after the standard configured-credential redaction.
New acceptance events also carry a boolean `queued`. When input must wait for
an active run, pending input, a paused queue or sandbox availability, acceptance
and `prompt.queued` are persisted atomically. The dispatcher emits `prompt.started`
before execution, after the previous prompt has settled, using the same prompt ID.
The renderer keeps a compact `Queued <avatar> <username> "<prompt>"` receipt at
submission time, then appends the full prompt at its first `prompt.started`.
Queued receipts use the Thinking block's spacing, conversation font and collapsible
surface. They start closed, expand the original input inline, and retain the
reader's open/closed choice across transcript updates.
Consecutive Queued receipts share one `Queued N prompts` collapsible block;
its expanded list retains every input's author and text in submission order.
Visible conversation turns separate groups. Adding another receipt preserves
the block's identity and open state; execution still renders each full prompt
separately at dispatch.
Resuming never duplicates that full prompt. Legacy acceptance events without
`queued` retain their existing display position. Acceptance acknowledges an
optimistic send even before the input is dispatched. Live replay and reload
produce the same chronological view.
`prompt.paused` carries the reason an interruption left the prompt unfinished —
`host_stopped` when the host stopped, `host_restarted` when a restart was only
discovered at the next boot or when the bundle generation process running the
prompt's tools crashed, `reader_stopped` when the reader stopped the run —
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

The reader's Stop button and Escape close a durable per-Thread dispatch gate
before aborting its active prompt. Repeated stops are idempotent, including when
the display names a prompt that just finished. Pending inputs and results that
arrive later remain accepted, and a backend restart preserves the gate. Sending
human input while paused adds it to the queue without reopening dispatch or
superseding the interrupted prompt, which remains resumable before the FIFO.
Agent-facing targeted interruption
keeps its separate child-prompt contract.
`GET /threads/:id/queue` returns a non-cached, revisioned snapshot with `paused`,
`stopping`, an optional resumable prompt, the current active or resumable prompt,
and FIFO pending items. The active prompt is excluded from the pending items.
Each item carries its prompt ID, source, display label, bounded
preview and acceptance time; the accepted event retains full detail.
`POST /threads/:id/queue/resume` refuses while stopping, otherwise resumes the
latest eligible reader-paused prompt first and then the FIFO. Queue state and
dispatch changes publish durable `queue.paused`, `queue.resumed` and
`queue.updated` notifications through the existing Thread watch. The renderer
reads snapshots through Electron IPC and ignores older revisions.
`DELETE /threads/:id/queue/:promptId` removes a pending or reader-paused input
under the same Project lock as dispatch. It refuses an input already executing.
Removal records `prompt.finished` with `status: cancelled` and
`reason: queue_removed`, so replay and boot cannot execute it, while its historical
receipt remains. Repeated removal is idempotent. Delegated input removal returns
a cancellation result to its parent through the existing result queue.
`GET /threads/:id/queue/:promptId` returns full effective text, edit eligibility
and the item's revision without caching. `PATCH` on that resource requires text
and that revision. Under the dispatch lock, only a user input that has never
started can be edited; paused, dispatched, completed and machine inputs cannot.
A stale revision conflicts. An edit persists `prompt.edited` before replacing
the in-memory input at the same FIFO position. Replay and recovery use its latest
text; the historical Queued receipt retains the original text. Queue snapshots
include each item's eligibility and revision, and edits invalidate the snapshot.

The conversation has one non-editable queue block immediately above its editable
prompt, anchored with that prompt rather than added to transcript history. It
shows a compact `Queue` heading and `Current:` and `Next:` groups, using the
conversation font and lightweight text. The section has no horizontal padding;
rows retain the Button's horizontal padding, compensated by negative margins
on both lists so their content aligns with the conversation. Inset focus rings
stay visible inside the scroll viewport. Pending
rows scroll within a bounded list; full details open in a popover. An empty queue
is hidden, as is a queue containing only an executing prompt with no pending
items. Current remains visible alongside pending items or while paused/stopping.
Hidden rows are removed from caret navigation; footer execution controls retain
the complete queue state. Queue updates preserve the draft and selection. Arrow keys traverse
each row between transcript and draft; Enter edits eligible user input in the
main composer and otherwise opens details. Clicking a row opens read-only
details. Delete or
Backspace removes the selected pending or paused input. The footer alone controls
dispatch: Arrow Up sends when the queue is empty, Play resumes queued work without
consuming the draft, and Pause stops an active run. While stopping or resuming,
the control is disabled. Sending into an empty paused queue reopens dispatch
before submission; sending while it still has items only appends input.
Cmd/Ctrl+Enter with an empty input resumes waiting queue items through the same
resume operation as the footer. It does nothing while running, stopping or
resuming, when queue loading failed, or when no items remain. Editing retains
priority: the shortcut saves the edited prompt and never resumes the queue.
Human items
share their avatar and username with historical Queued receipts; machine inputs
retain their source identity. There is no divider between the queue and prompt.
Editing preserves the prior composer draft. The composer and selected queue row
use the caret-focus muted tone at 50% opacity, without an editing border. Its header reads
`Editing: <avatar> <username> "<original prompt>…"`; Editing uses the conversation's muted foreground
at weight 400. The footer checkmark and Cmd/Ctrl+Enter save; Escape restores the
draft without pausing execution. No cancel button is shown. Pause remains
available while running. Save conflicts retain the typed edit, and text entered
while a save is pending is never discarded by the response.

The conversation states the two lifecycle events as markers between the blocks
they sit between: a pause reads as a quiet row — the reason it
paused — and a resume as a quiet row naming its attempt, with the option to take
a reader-paused prompt up again offered on that row. These use separator markers
with 12-pixel text, no pause/play icons and space above and below. The resume
action is a compact RotateCcw-icon button with an accessible name. The transcript caret skips
them in both directions; the resume button retains normal click and Tab access.
Recovery (`prompt.resumed`) alone does not render a resume marker: the projector
waits for the next `agent.started` for that prompt and only shows a marker when
an earlier execution of the same prompt had started. A recovered input that had
never executed begins normally, without a resume marker. A recovered pause loses
its manual resume action while queued. When no visible turn intervenes, its next
execution replaces the pause marker with the resumed attempt and preserves the
pause reason in the tooltip; otherwise the resume marker appears at the actual
start. Live batches and replay apply the same rule, and rewind reconstructs this
state from surviving events. Durable events and the host's attempt budget remain
unchanged. A newer user prompt accepted outside the queue in the same Thread supersedes
older paused prompts: their resume action disappears, the host rejects manual
resume, and boot recovery never schedules them again. Delegated inputs do not
supersede a pause. Acceptance marked `queued: true` also preserves the current
pause and its resume action, including when replaying history after a restart.
A prompt closed because its
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
