# Feature: error messages

- Status: `implemented`
- Brief: none
- Specs: [docs/designs/error-messages.md](../designs/error-messages.md)
- Decisions: [Mensagens de erro (2026-11-16)](../architecture/bundles/implementation-decisions.md#mensagens-de-erro-2026-11-16)

## Problem

The desktop UI bundles `chat`, `settings` and `layout` showed failures in 33 places with five styles and no shared component: raw red text with visible `Caused by:` chains, adapters that dropped the error code and cause, almost no Retry or copy action, toasts without ids that stacked, a rename failure shown twice, Portuguese compaction strings, and silent failures — a bundle quarantined in a window was reported nowhere, and two settings reads were never shown.

## Decisions

The user's requirements (U1–U8, 2026-11-16):

- One contextual notice, `ErrorNotice`: each failure stays where it happens, all through one component with an icon, a title from the error code, an explanation, actions and collapsed technical details. Toasts only for background actions, always with an id. Form validation stays inline under the field.
- Actions are Retry and Copy details only.
- English everywhere, including the compaction row and the host's exhausted-resume message.
- Out of scope: the OpenUI errors card, the splash failure screens and the feature bundles (`git`, `files`, `terminal`, `mcp`, `papercraft`, `usage`), which a follow-up moves.
- New: one notice for the window's quarantined bundles.
- Tool errors and compaction failures carry their code and structured cause chain to the UI; settings keeps the contract error's code and cause.
- The look is the one the user approved in a papercraft review on 2026-11-16.

Design decisions (spec D1–D18), recorded in [implementation decisions](../architecture/bundles/implementation-decisions.md#mensagens-de-erro-2026-11-16):

- `ErrorNotice` and `toastError` live in `packages/desktop/src/error-notice.tsx`, the platform module `desktop/ui/error-notice`.
- The error value `ErrorInfo`, its normalizer `errorInfo`, `ClientError` and the catalog types `ErrorCatalog` and `ErrorCatalogEntry` live in `desktop/reads`, which each client part embeds; they are not platform API.
- The error catalog is split: the platform holds the entries of the codes the platform and shared packages define, worded without naming a bundle; each bundle holds its own codes and its own wording for shared codes and passes its catalog, merged over the shared entries.
- The title comes from the headline level's code; the explanation from the entry, else the error's own message.
- Retry shows only when the surface passes `onRetry`, the entry is retryable and the error does not say `retryable: false`. Surfaces pass it only for reads, for idempotent writes (the execution picker's write, the queue's resume) and for the failed-prompt block. Copy details shows on every notice.
- Stacks, `ContractError.details`, `diagnostic` and request payloads never enter `ErrorInfo`.
- A workspace request failure is shown once; `EditableName` shows no toast.

## Current behavior and contracts

- **The notice.** Variants `block` (thin card), `compact` (no card) and `inline` (row 1 only, no details). Row 1: tone icon (or a given `icon`), the title on one line truncated with an ellipsis, icon-only Retry (spinning while retrying) and Copy details. Row 2: the muted explanation followed by an underlined "Details" link ("Hide details" when open) that reveals the details below a hairline. The details list code, provider, status, message, one line per cause, context lines and the time when known; the copy text is the title, the explanation and the details. `announce` makes a notice announce itself once.
- **Toasts.** `toastError` takes a required id and draws a `compact` notice in a Sonner custom toast for 4 000 ms, kept open while its details are open; a later failure with the same id replaces it. Failure and success ids differ: settings uses `config-save-failed` / `config-save`, `claude-login-failed` / `claude-login` and `credentials-write-failed` / `credentials-write`, and each success first dismisses its failure toast. Chat toasts use `thread-send-<threadId>`, `thread-stop-<threadId>`, `thread-queue-<threadId>`, `chat-intent-<command>`, `queue-edit-<threadId>` and `attach-image-<threadId>-<name>`; the dashboard's provider page uses `provider-open-site`. A non-failure hint keeps its own id, `queue-edit-hint-<threadId>`.
- **Chat.** A failed prompt is a block notice whose Retry, shown for the last prompt's failure while the agent control's status is `failed` and `canRetry` holds, calls `threads.retry`. A failed tool call and a failed compaction draw compact notices with the code and cause chain built from the stored `tool.failed`, `agent.failed` and `compaction.failed` events, so older logs gain codes with no migration. `EditToolItem` takes a `name: 'edit' | 'write'` prop. The compaction row, its copy toasts and its numbers (`en-US`) are English.
- **Settings.** Adapters reject with `ClientError` (`SettingsApiError` extends it) keeping the code and, except for `internal`, the cause. The execution picker shows an inline notice instead of its alert span. The provider kinds and credentials list reads, not shown before, now show notices with Retry: in the settings window, announced block notices (the kinds failure through `SettingsProviders`' `kindsFailure` prop), and the dashboard's `DashboardProvidersGroup` shows a compact one (its `failure` prop). While a Retry refetches, the last read failure stays on screen (`use-read-failure.ts`).
- **Workspace.** One workspace error notice (`WorkspaceErrorNotice`, in the `workspace` bundle since bundle isolation step 4(c); the layout's before) shows a workspace failure, in the sidebar in the frame's conversation form and in the dashboard body in its page form. A failed Projects or Threads load offers Retry, which loads it again; a failed create, rename, color change or delete offers none. Its fallback code follows the retry target: `projects_load_failed`, `threads_load_failed`, else `workspace_action_failed`. The dashboard keeps the last list failure on screen during Retry.
- **Quarantine.** One warning notice at the bottom of the left sidebar of the frame on screen — in the conversation form at the sidebar's bottom edge after the stack panes (that sidebar has no footer), in the page form directly above the "All settings" footer — reads the window's own bundle catalog (`doric.catalog/v1`) and names every quarantined bundle ("N extension(s) couldn't start"), its details one bundle per line with its reasons; the regions those bundles fill stay empty. The catalog is read once per mount, so a bundle quarantined later shows after a frame switch remounts the sidebar. `ElementHost`, the platform's `desktop/ui/element-host`, shows a compact notice only when creating an element throws. Blind spots accepted: a quarantined `layout`, and the settings window, show no notice.
- **Data.** `compaction.failed` carries `{ code, error? }` (`executor/v1` 1.5.0). The host's `resume_exhausted` failure message is English, and the chat titles it "Execution stopped".
- **Versions.** Platform 1.7.0 (`PLATFORM_ASSETS_VERSION` stays 1.0.0); `chat` 1.7.0, `settings` 1.7.0, `layout` 3.1.0, each with `engines.doric` `^1.7.0`; `default` 2.6.0 (`executor/v1` 1.5.0); `runtime` 2.7.1. An app older than platform 1.7.0 quarantines the new UI bundles (`engines_unsatisfied`).

## Evolution

- 2026-11-16: implemented ([spec](../designs/error-messages.md) version 10 with errata). The shared `ErrorNotice` and `toastError`, the split error catalog, codes and cause chains kept by the chat, settings and layout adapters, `compaction.failed` carrying its error, English compaction and resume strings, the settings read notices, the single workspace error notice and the window's quarantine notice.
- 2026-11-18: bundle isolation, step 4(c) ([feature](bundle-isolation.md), [spec](../designs/bundle-isolation.md)). The workspace error notice and its error catalog move with the navigation from the layout to the new bundle `workspace` 0.1.0, unchanged on screen; the quarantined-bundle notice stays in the layout's frame (layout 5.0.0). The layout reports a failed close of a viewer tab, and the chat a failed open, retitle or close of its Thread tab, with `console.error('Doric: …')`.
