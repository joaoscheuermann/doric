# Spec: model icons

- Ticket: none given.
- Status: approved by the user (version 5, 2026-11-03); version 6 rebases it onto `1f22384d` without changing the user's decisions; see [Revisions](#revisions). Line references are checked against commit `1f22384d`.
- Bundles touched: `bundle` package (`models.provider/v1` 1.1.0 → 1.2.0, `models/v1` 1.2.0 → 1.3.0); `core` 1.12.0 → 1.13.0; `claude`, `codex`, `openai`, `openrouter` 1.0.0 → 1.1.0; `settings` 1.3.0 → 1.4.0 (requires `models/v1@^1.3.0`); `chat` 1.5.1 → 1.6.0 (takes `models/v1` as optional). Packages `llms` (the icon set, its names and its provenance) and `desktop` (`svgMask` in `desktop/ui/utils`).
- Feature docs: [docs/features/model-icons.md](../features/model-icons.md). The file does not exist yet; the docs step creates it from this spec (see [Docs to update](#docs-to-update)).
- Paths are written from the repository root. A line reference names the file as it is before this change.

## Problem

The desktop draws no model icon, the one brand mark it draws is chosen by the renderer, and the conversation's two marks no longer match the previews the user approved ([Approved previews](#approved-previews)):

- The execution picker's trigger shows only the model's name (`bundles/desktop/settings/src/client/components/molecules/model-picker.tsx:78`), and each model row only its label and note (`bundles/desktop/settings/src/client/components/molecules/choice-list.tsx:46-57`).
- The dashboard's provider rows and the provider page header draw `ProviderIcon` (`bundles/desktop/settings/src/client/components/organisms/dashboard-providers.tsx:78-81`, `bundles/desktop/settings/src/client/components/organisms/dashboard-provider-page.tsx:53-57`). `ProviderIcon` picks a mark from a list the renderer carries: a computer for a local endpoint, a hard-coded brand path for four kinds, a server otherwise (`bundles/desktop/settings/src/client/components/molecules/provider-icon.tsx:12-37`, `bundles/desktop/settings/src/client/domain/provider-icon.ts:4-46`, `bundles/desktop/settings/src/client/components/molecules/provider-icon-paths.ts:1-5`). That contradicts the rule that the renderer learns kinds and models from the host rather than carrying a list of its own (`GROUNDING.md:578-580`).
- The conversation's agent mark is a fixed bot on an off-white face with a rim (`bundles/desktop/chat/src/client/components/organisms/conversation/nodes/turn-avatar.ts:23-41`, `bundles/desktop/chat/src/client/styles.css:217-261`). It does not say which model answered.
- The reader's mark is a circle (`bundles/desktop/chat/src/client/styles.css:225`, `bundles/desktop/chat/src/client/components/molecules/reader-avatar.tsx:14-15`). The user approved the agent's icon and the reader's square together (P2, P3) and decided that both enter this feature, so the gutter's two marks change in one step.

## Terms

### Architecture

| Term                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle                    | A versioned unit with a manifest that provides and requires contracts (`docs/architecture/bundles/contracts.md:7`, `docs/architecture/bundles/manifest.md`).                                                                                                                                                                                                                                               |
| Contract                  | A bundle's versioned public interface, `<domain>/vN`, written in zod; a new method is a minor version (`docs/architecture/bundles/versioning.md:44`).                                                                                                                                                                                                                                                      |
| Basic contract            | A contract `bundle/contracts` defines and any bundle may provide, such as `models/v1` and `models.provider/v1` (`docs/architecture/bundles/contracts.md:89`). Its provider must implement exactly the platform's method set and schemas, or `provide` fails with `contract_mismatch` (D-12, `docs/architecture/bundles/implementation-decisions.md:124`; `packages/bundle/src/runtime/services.ts:45-90`). |
| Host                      | The backend processes: a kernel that runs the platform, the foundation and the core, and one process per generation of feature bundles (`docs/architecture/bundles/process-isolation.md:7`).                                                                                                                                                                                                               |
| Envelope                  | The RPC between the kernel and a generation process, validated against each contract's schema (`docs/architecture/bundles/process-isolation.md:7`). A cross-process call is one envelope round trip.                                                                                                                                                                                                       |
| Renderer                  | The desktop window, where the client parts of bundles such as Settings and the chat run.                                                                                                                                                                                                                                                                                                                   |
| Bridge                    | The channel through which a renderer bundle calls a host service (`docs/architecture/bundles/services-and-channels.md:322`). A method marked `expose: 'desktop'` is one the bridge lets a window call (`docs/architecture/bundles/services-and-channels.md:362`).                                                                                                                                          |
| Core                      | The bundle that provides the basic contracts by default, `models/v1` among them (`docs/architecture/bundles/core.md`).                                                                                                                                                                                                                                                                                     |
| `defineMethod`, `CallArg` | `defineMethod` writes a method from its zod spec and its `execute`. `CallArg` is a method's optional last argument, a parent call or `{ signal?, deadline? }` (`packages/bundle/src/contracts/call.ts:60`); a `deadline` aborts the call when it passes (`packages/bundle/src/runtime/call.ts:131-145`).                                                                                                   |

### Models

| Term                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider kind          | A kind of model provider — `claude`, `codex`, `openai`, `openrouter` — defined by a `KindDefinition` in its provider bundle (`bundles/providers/openai/src/host/provider.ts:31-46`). A kind is advertised when `models/v1.kinds()` lists it; `codex` is not advertised, and `kind(id)` finds both (`docs/architecture/bundles/implementation-decisions.md:398`).                                                                     |
| Provider record        | The `models.provider/v1` service one provider bundle registers for its kind; the core sees every record through `whenAvailable` (`bundles/foundation/core/src/host/models/index.ts:96`) and finds one by kind with `registry.find` (`bundles/foundation/core/src/host/models/registry.ts:82`).                                                                                                                                       |
| Provider               | One configured instance of a kind in the user's configuration: an id, a kind and provider values.                                                                                                                                                                                                                                                                                                                                    |
| Provider values        | A provider's string values, one per field its kind declares, such as `endpoint`; the contracts carry them in a field named `configuration` (`packages/bundle/src/contracts/basic/models.ts:189`).                                                                                                                                                                                                                                    |
| Active configuration   | The providers of the last `models/v1.prepare` with a revision, as the core keeps them (`bundles/foundation/core/src/host/models/providers.ts:115-133,163`).                                                                                                                                                                                                                                                                          |
| Settings configuration | The whole configuration Settings edits, type `Configuration` (`bundles/desktop/settings/src/client/domain/config.ts`).                                                                                                                                                                                                                                                                                                               |
| Draft                  | The Settings configuration before it is saved (`useConfig`, `bundles/desktop/settings/src/client/components/organisms/execution-picker.tsx:26-27`), including a provider not saved yet (`emptyProviderDraft`, `bundles/desktop/settings/src/client/domain/config.ts:847-852`; its page reads "Add provider", `bundles/desktop/settings/src/client/components/organisms/dashboard-provider-page.tsx:59-61`). "Draft" means only this. |
| Effort rows            | The reasoning-effort choices the picker lists for a model (`bundles/desktop/settings/src/client/components/molecules/model-picker.tsx:152-160`) and the effort picker's rows (`bundles/desktop/settings/src/client/components/molecules/effort-picker.tsx:54`).                                                                                                                                                                      |

### Icons

| Term                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Icon                | One SVG document, drawn mono: only its shape counts, painted in the text color.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Icon name           | The key of one icon in the shared set `packages/llms` ships: `claude`, `deepseek`, `gemini`, `gemma`, `meta`, `openai`, `openrouter`, `qwen`. Providers choose icons by name.                                                                                                                                                                                                                                                                                                                                                                                 |
| Model icon          | The icon a provider kind chooses for one model it serves, for example Claude for `anthropic/claude-sonnet-4` on OpenRouter. A model may have none.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Provider's own icon | The icon a provider kind chooses for a provider as a whole, for example OpenRouter. A provider may have none (an `openai` provider on a compatible endpoint).                                                                                                                                                                                                                                                                                                                                                                                                 |
| Fallback            | A model without a model icon wears its provider's own icon; with neither, it has no icon.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Bot glyph           | The robot drawing the chat's agent mark shows today, constant `AGENT_MARK` (`bundles/desktop/chat/src/client/components/organisms/conversation/nodes/turn-avatar.ts:35-41`).                                                                                                                                                                                                                                                                                                                                                                                  |
| Gutter mark         | The mark a turn block draws in the conversation's left gutter through its own pseudo-elements (`bundles/desktop/chat/src/client/styles.css:194-205`): today the reader's `::after`, and the agent's `::before` (face) and `::after` (glyph) (lines 217, 241-246); after §10, one `::after` each.                                                                                                                                                                                                                                                              |
| Mask drawing        | Painting an element's background through a CSS `mask` whose image is a `data:image/svg+xml` URL. The SVG is decoded as an image, never put in the document. The bot glyph is drawn this way today (`bundles/desktop/chat/src/client/styles.css:258-259`).                                                                                                                                                                                                                                                                                                     |
| LobeHub icons       | `@lobehub/icons-static-svg` 1.102.0, MIT, https://github.com/lobehub/lobe-icons; tarball `https://registry.npmjs.org/@lobehub/icons-static-svg/-/icons-static-svg-1.102.0.tgz`, integrity `sha512-3Na6S2kdslmsfnBjuL0PQWQClrmuWe/pWThRN/3J2VzPg5MhVghy8knVu7kd1/lqA9ydZBvwmnKLzuBo0Wm6Qw==`, `gitHead` `989535d6c13da2dec5a2937fe2789d4af4fdd8e0` (from `npm view`). The tarball holds `README.md`, `package.json` and `icons/` only; it has no LICENSE file. The repository's `LICENSE` at that `gitHead` is the MIT text with `Copyright (c) 2023 LobeHub`. |

## Approved previews

The user approved three previews before this spec. They live in `.doric/artifacts/drafts/`, which `.gitignore:9` excludes, so a clone does not have them; this section is their record.

- **P1, the picker** (`.doric/artifacts/drafts/model-picker-icons/model-picker-icons.stories.tsx`, story `PopoverAndToggle`). The execution picker over the Settings stories' fixture configuration — an `openrouter` provider, an `openai` provider and a local OpenAI-compatible one — plus `acme/coder-7b` on OpenRouter. Every model row of the open popover draws a 16px mono icon before its name; the closed triggers draw the selected model's icon before its name; `acme/coder-7b` wears OpenRouter's icon; the effort rows draw none. Each model's icon came from a draft of the per-kind rules that U6 records.
- **P2, the agent's mark** (`.doric/artifacts/drafts/conversation-model-icons.css`). The agent's gutter mark without its face and rim, drawing only an icon inside the unchanged 1.375rem box, at sizes from 16px to 22px, mono and in color. The user chose 18px mono (U4).
- **P3, the reader's mark** (`.doric/artifacts/drafts/conversation-square-avatars.stories.tsx`, story `SideBySide`). The reader's gutter mark and `ReaderAvatar` as squares with 25% corners, beside the circles they replace.

## Decisions already made

These were made with the user and are not reopened. U8-U13 are the user's answers to the open questions of versions 1 to 3.

- **U1. The provider owns the icon.** It chooses one per model; the renderer only draws what the host answers (`GROUNDING.md:578-580`).
- **U2. Picker.** The model's icon is drawn at 16px, mono in the text color (`currentColor`), before the name in every model row of the popover, and in the trigger before the selected model's name. The effort rows get no icon and no empty slot (P1).
- **U3. Provider pages migrate in the same change.** `provider-icon-paths.ts` and the mark code §7 lists are removed. `providerSite` is a site link, not an icon, and stays.
- **U4. Conversation, agent.** The gutter mark loses its face and rim and shows only the icon of the model that answered that turn, after the fallback, mono in the text color, centered in the unchanged 1.375rem (22px) box at the size U8 sets, and empty or the bot glyph as U11 sets (P2).
- **U5. Conversation, reader.** The reader's mark becomes a square with a border-radius of 25% of its side (5.5px on the 22px gutter mark, 5px on the 20px `ReaderAvatar`): on the gutter (`::after` of `[data-turn-avatar='user']`, on turns, the prompt and the composer's stack) and on `ReaderAvatar` everywhere it is drawn (P3).
- **U6. The icons each provider kind chooses** (P1, refined by U10, U12 and U13):
  - `claude`: Claude for every model; own icon Claude.
  - `codex`: OpenAI for every model; own icon OpenAI.
  - `openai` on OpenAI's own endpoint: OpenAI for every model; own icon OpenAI.
  - `openai` on a compatible endpoint (Ollama, LM Studio, Azure, LiteLLM…): the family the model's name says (§3 gives the order); own icon none.
  - `openrouter`: the lab the id's prefix names — `anthropic/` → Claude, `openai/` → OpenAI, `google/gemma` → Gemma, other `google/` → Gemini, `deepseek/` → DeepSeek, `qwen/` → Qwen, `meta-llama/` → Meta; own icon OpenRouter.
  - The fallback applies (`acme/coder-7b` on OpenRouter → OpenRouter). With no icon at all, the picker keeps its 16px slot empty so labels stay aligned.
- **U7. The SVGs are LobeHub's mono icons** from `@lobehub/icons-static-svg` 1.102.0 (MIT), recorded in the repository with their provenance and license as HC-008 asks ("generated, vendored, lock and build artifacts need provenance", `GROUNDING.md:3225-3231`). The set is the eight icons some rule of U6 names.
- **U8 (version 1, Q1). The gutter icon is 18px.** The box stays 1.375rem (22px); the icon is drawn centered in it at 1.125rem (18px). The picker stays at 16px.
- **U9 (version 1, Q2). A provider without an own icon shows lucide's `ServerIcon` on the provider pages**, a local endpoint included. The renderer has no endpoint rule.
- **U10 (version 1, Q3). The `claude` kind's own icon is Claude.** No rule names the Anthropic icon, so it is not in the set.
- **U11 (version 1, Q4). The agent's mark is empty until its icon arrives.** The bot glyph appears only when the icon is known to be absent: a log without the answering provider, a provider the active configuration no longer has or whose kind chooses none, or a host without `models/v1.icons`.
- **U12 (version 2, Q5, and the question after version 3). Gemma models wear LobeHub's Gemma icon, and compatible endpoints match every supported model family by name.**
  - On OpenRouter, `google/gemma…` ids wear Gemma, not Gemini or OpenRouter. The source is `icons/gemma.svg` (mono); `gemma-color.svg` and `gemma-text.svg` are not used.
  - On a compatible endpoint, asked whether a name containing `gemma` (such as `gemma3:12b` on Ollama) wears Gemma, the user answered: "Sim, ícones do Gemma e outros que tivemos suporte também" ("Yes, the Gemma icon, and the other icons we support too"). The name rule therefore covers every model family of the set: Claude, Gemini, Gemma, OpenAI (`gpt`, U13), DeepSeek, Qwen and Meta (`llama`). OpenRouter is a provider brand, not a model family, and no name matches it.
- **U13 (version 2, new). `gpt` on a compatible endpoint wears OpenAI**: an `openai` model on a compatible endpoint whose name contains `gpt` (Azure, LiteLLM, `gpt-oss` on Ollama).

## Goals

- **G1.** `models.provider/v1` 1.2.0 lets each provider kind choose icons by name, and the four kinds choose those of U6 (§1, §3).
- **G2.** `models/v1` 1.3.0 answers the renderer, for a draft or a configured provider, each model's icon after the fallback and the provider's own icon, as SVG; a failing or slow provider costs only its own entries (§4).
- **G3.** The picker follows U2 (§6).
- **G4.** The provider pages follow U3 and U9; no list of icons, brand paths or endpoint rule remains in the renderer (§7).
- **G5.** The agent's gutter mark follows U4, U8 and U11; the reader's marks follow U5 (§10, §11).
- **G6.** The eight SVGs are recorded with their source, hashes, edits and license (U7, §2).
- **G7.** No SVG from the host is inserted into the document (§5).

## Non-goals

- The lucide `BotIcon` sites outside the gutter stay as they are: `bundles/desktop/chat/src/client/components/molecules/prompt-author.tsx:1,15`, `bundles/desktop/chat/src/client/components/molecules/thread-nav-rail.tsx:252`, `bundles/desktop/chat/src/client/components/molecules/comment-thread-pin.tsx:122-123`, `bundles/desktop/chat/src/client/components/organisms/conversation/nodes/delegated-turn-node.tsx:76`, `bundles/desktop/chat/src/client/components/organisms/agent-thread-controls.tsx:85`.
- An agent's comment reply keeps drawing `ReaderAvatar` with the initials of `agent` (`bundles/desktop/chat/src/client/components/molecules/comment-line.tsx:124,136`); it becomes a square only because `ReaderAvatar` does (U5).
- No brand color variant: every icon is mono.
- No model icon anywhere else in the chat (trail previews, thread rail, footers, the author line).
- No icon in the provider page's model catalog table.
- No change to the runtime's events: the chat reads the `providerId` the default runtime already records (`bundles/runtime/default/src/host/executor.ts:556-559`).
- No icon a provider bundle brings from outside the shared set (D2).
- `providerSite` and its `sites` table stay where and as they are (`bundles/desktop/settings/src/client/domain/provider-icon.ts:48-58`). The table is a renderer-side list keyed by kind, of site links, not icons; U3 covers icons only.

## Design decisions

| #   | Decision                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `models.provider/v1` gains one method that answers, for a provider's values and some model names, the provider's own icon and each model's icon, by icon name.                                           |
| D2  | Icons are named from one shared set in `packages/llms`. The provider chooses names; the core turns names into SVG. A name the core does not know is no icon.                                             |
| D3  | The provider receives the provider values (the endpoint decides `openai`) and the model names, never a secret; choosing icons does no I/O.                                                               |
| D4  | The core applies the fallback, once for every kind; providers answer only their own choices.                                                                                                             |
| D5  | A provider record whose method rejects, does not answer within 1000 ms, or answers out of shape has no icon for that request, and the core's answer does not fail with it.                               |
| D6  | `models/v1` gains one desktop-exposed, batched method. A request names a configured provider by id (the chat) or a draft by kind and values (Settings).                                                  |
| D7  | The `models/v1` answer carries icon names and, once each, the SVG of every name it uses, so its size is bounded by the icon set, not by the number of models.                                            |
| D8  | The icon set is a TypeScript module in `packages/llms`, copied from the tarball by a procedure `packages/llms/PROVENANCE.md` states, with the source and stored hashes of each icon.                     |
| D9  | Each kind's rule lives in its `kind.ts`. The two model rules it may call — by OpenRouter lab and by model name — read one family table in `packages/llms`, so an icon added to the set reaches both.     |
| D10 | The chat learns which model answered a turn from the log's `response.started`, and asks the host for that pair's icon; it caches answers for the window's life, and a failed read leaves the mark empty. |

## Design

### 1. Contracts: `models.provider/v1` 1.2.0 and `models/v1` 1.3.0

File `packages/bundle/src/contracts/basic/models.ts`. `models/v1` is already at 1.2.0, which added `inputModalities` (lines 158-167) over `catalogModelRequestSchema` (lines 191-194); `icons` makes it 1.3.0. `models.provider/v1` is at 1.1.0 (`bundles/providers/openai/manifest.json:7`), and `icons` makes it 1.2.0, so the two contracts' new members carry different version tags below. The new schemas are declared after `configurationValuesSchema` (`packages/bundle/src/contracts/basic/models.ts:189`), which they use, and after `catalogModelRequestSchema`, before `modelsMethods` (line 196): `configurationValuesSchema` is not exported and is declared after the `Models` interface (lines 125-168), so a schema placed above it would read it before its initialization and the module would throw at load. The interfaces refer only to the schemas' types. `bundle/contracts` cannot depend on `llms` (`packages/bundle/src/contracts/basic/models.ts:7-8`), so an icon name is a string here and the set of names lives in `llms`.

```ts
/** models/v1 1.3.0: the longest SVG an icon may be, in characters. */
export const MODEL_ICON_MAX_LENGTH = 16_384;
/** models/v1 1.3.0, models.provider/v1 1.2.0: the most model names one icon request may list. */
export const MODEL_ICON_MAX_MODELS = 1000;
/** models/v1 1.3.0, models.provider/v1 1.2.0: the longest model name an icon request may list, in characters. */
export const MODEL_ICON_MAX_NAME = 512;
/** models/v1 1.3.0: the most requests one `models/v1.icons` call may carry. */
export const MODEL_ICON_MAX_REQUESTS = 64;

const iconNameSchema = z.string().min(1).max(64);
const iconModelsSchema = z
  .array(z.string().max(MODEL_ICON_MAX_NAME))
  .max(MODEL_ICON_MAX_MODELS);

/**
 * models/v1 1.3.0: one icon as SVG markup. The desktop draws it as a CSS mask, so only
 * its shape counts, and never puts it in the document.
 */
export const modelIconSvgSchema = z
  .string()
  .max(MODEL_ICON_MAX_LENGTH)
  .startsWith('<svg');

/**
 * models/v1 1.3.0, models.provider/v1 1.2.0: the icons a provider chooses, by name: its own (absent for none) and,
 * per requested model in the same order and length, that model's own or `null`.
 */
export const modelIconChoiceSchema = z
  .object({
    provider: iconNameSchema.optional(),
    models: z.array(iconNameSchema.nullable()),
  })
  .strict();
export type ModelIconChoice = z.output<typeof modelIconChoiceSchema>;

/** models/v1 1.3.0: a configured provider by id, or a draft by kind and values. */
export const modelIconRequestSchema = z.union([
  z.object({ providerId: z.string(), models: iconModelsSchema }).strict(),
  z
    .object({
      kind: z.string(),
      configuration: configurationValuesSchema,
      models: iconModelsSchema,
    })
    .strict(),
]);
export type ModelIconRequest = z.output<typeof modelIconRequestSchema>;

/**
 * models/v1 1.3.0: the answers to one `icons` call, in request order, by icon name, with
 * the fallback applied to each model; `svgs` holds the SVG of every name the
 * answers use, once.
 */
export const modelIconAnswersSchema = z
  .object({
    svgs: z.record(iconNameSchema, modelIconSvgSchema),
    answers: z.array(modelIconChoiceSchema),
  })
  .strict();
export type ModelIconAnswers = z.output<typeof modelIconAnswersSchema>;
```

`Models` (`packages/bundle/src/contracts/basic/models.ts:125-168`) gains, after `inputModalities`:

```ts
  /**
   * 1.3.0: the icons of some models and of their providers. A request names a
   * provider of the active configuration (`providerId`) or a draft (`kind` and
   * its values). Every name an answer uses is a key of `svgs`. An unknown
   * provider or kind, or a provider whose `icons` fails or is slow, answers no
   * provider icon and `null` for each model; it never throws for those.
   */
  icons(
    input: { readonly requests: readonly ModelIconRequest[] },
    call?: CallArg,
  ): Promise<ModelIconAnswers>;
```

`modelsMethods` (`packages/bundle/src/contracts/basic/models.ts:196-227`) gains, after `inputModalities` (lines 223-226):

```ts
  icons: {
    input: z
      .object({
        requests: z.array(modelIconRequestSchema).max(MODEL_ICON_MAX_REQUESTS),
      })
      .strict(),
    output: modelIconAnswersSchema,
    expose: 'desktop',
  },
```

`ModelsProvider` (`packages/bundle/src/contracts/basic/models.ts:240-263`) gains:

```ts
  /**
   * 1.2.0: the icons this kind chooses for a provider's values, by name: its
   * own and, per listed model, that model's own. No fallback.
   */
  icons(
    input: {
      readonly configuration: Readonly<Record<string, string>>;
      readonly models: readonly string[];
    },
    call?: CallArg,
  ): Promise<ModelIconChoice>;
```

`modelsProviderMethods` (`packages/bundle/src/contracts/basic/models.ts:267-292`) gains:

```ts
  icons: {
    input: z
      .object({ configuration: configurationValuesSchema, models: iconModelsSchema })
      .strict(),
    output: modelIconChoiceSchema,
  },
```

**Why names between provider and core, and SVG between core and renderer.** The provider owns the choice (U1): which icon a model wears is decided by its kind's rule and nowhere else. The drawings are a shared, licensed asset that every kind and the core already reach through `llms` (`bundles/providers/openai/package.json:17`, `bundles/foundation/core/package.json:25`). A provider answering SVG markup would send nothing the name does not say, and the core would have to check markup from four bundles instead of eight known names. The renderer has no icon set, so it must receive SVG. There the answer carries each used SVG once (`svgs`), keyed by name: a Settings call may list up to 64 × 1000 models, and with the SVG repeated per model the answer would grow with the model count, while the dictionary bounds it by the set (the eight stored values total 10,839 characters, §2). A provider bundle built outside this repository can choose only among the shared names; a later minor version can add an optional SVG field to `ModelIconChoice` if one needs its own.

**Names across layers.** `ModelIconRequest` is the contract's request. Settings keeps its own `IconRequest` (§6): the draft form of `ModelIconRequest` plus the provider id, which Settings keeps and does not send. `ModelIconChoice` is a provider's answer, and also each entry of `ModelIconAnswers.answers` after the fallback. `KindIcons` (§3) is `ModelIconChoice` typed with the `llms` names, so a misspelled name fails to compile in the provider bundle; the provider record returns it unchanged. Settings keeps the host's `ModelIconAnswers` as they are and reads each name through `svgs` (§6), so each SVG is held once in the renderer too.

### 2. The icon set in `packages/llms` and its provenance

`packages/llms` already holds the shared provider logic every provider bundle and the core depend on, and exports only TypeScript modules through `src/index.ts` (`packages/llms/src/index.ts:1-23`, `packages/llms/package.json:8-17`). The icons go there as a TypeScript module, so no asset wiring is added.

#### The module

`packages/llms/src/lib/icons/lobehub.ts`:

```ts
// The LobeHub mono icons Doric names, from @lobehub/icons-static-svg 1.102.0
// (MIT, Copyright (c) 2023 LobeHub). Each value is a source file with the
// edits packages/llms/PROVENANCE.md lists; change a value only by repeating
// those steps and updating the hashes there.
export const lobehubIcons = {
  claude: '<svg …>…</svg>',
  deepseek: '…',
  gemini: '…',
  gemma: '…',
  meta: '…',
  openai: '…',
  openrouter: '…',
  qwen: '…',
} as const;
```

Keys in alphabetical order. Each value is the file `icons/<key>.svg` of the tarball, read as UTF-8, after these three replacements, in order (the ones preview P1 made):

```js
svg
  .replace(/<title>[^<]*<\/title>/, '')
  .replace(/\s(height|width)="1em"/g, '')
  .replace(/\sstyle="[^"]*"/, '');
```

No source file has leading or trailing whitespace, a line break, a backslash or a single quote, so each value is written between single quotes with no escape, and the module's literal is the value byte for byte. Biome's `quoteStyle` is `single` (`biome.json:34,45`), so formatting does not change it.

`packages/llms/src/lib/icons/index.ts`, exported from `packages/llms/src/index.ts` (`export * from './lib/icons/index.js';`):

```ts
/** The icons a provider kind may name. */
export type ModelIconName = keyof typeof lobehubIcons;

/** Whether a string names an icon of the set. */
export const isModelIconName = (value: string): value is ModelIconName =>
  Object.hasOwn(lobehubIcons, value);

/** The SVG of a named icon. */
export const modelIconSvg = (name: ModelIconName): string => lobehubIcons[name];

/** One model family of the set: its icon, its OpenRouter lab and the word its names contain. */
export interface ModelFamily {
  readonly icon: ModelIconName;
  readonly lab: OpenRouterLab;
  readonly word: string;
}

/**
 * The model families, in matching order. OpenRouter is a provider brand, not a
 * model family, so it has no row.
 */
export const modelFamilies: readonly ModelFamily[] = [
  { icon: 'claude', lab: 'anthropic', word: 'claude' },
  { icon: 'gemini', lab: 'gemini', word: 'gemini' },
  { icon: 'gemma', lab: 'gemma', word: 'gemma' },
  { icon: 'openai', lab: 'openai', word: 'gpt' },
  { icon: 'deepseek', lab: 'deepseek', word: 'deepseek' },
  { icon: 'qwen', lab: 'qwen', word: 'qwen' },
  { icon: 'meta', lab: 'llama', word: 'llama' },
];

/**
 * The icon of an OpenRouter model: the family whose lab
 * `openRouterProfileForModel` reads from its id; any other lab (kimi, mistral,
 * xai, glm, cohere, minimax, unknown) → null.
 */
export const openRouterModelIcon = (model: string): ModelIconName | null;

/**
 * The icon a model's name says: the first family whose word is a substring of
 * the lowercased name; none → null.
 */
export const modelNameIcon = (model: string): ModelIconName | null;
```

- `openRouterModelIcon` reads `openRouterProfileForModel(model).lab` (`packages/llms/src/lib/providers/openrouter/profiles.ts:1-15,89-93`), the one prefix table OpenRouter ids are sorted by (`packages/llms/src/lib/providers/openrouter/profiles.ts:39-87`), so the icon rule and the request profiles cannot disagree. That table checks `google/gemma` before `google/` (`packages/llms/src/lib/providers/openrouter/profiles.ts:43-50`), which gives Gemma models the Gemma icon (U12). `OpenRouterLab` is the type of that file (lines 1-15); `packages/llms/src/lib/icons/index.ts` imports it from `../providers/openrouter/profiles.js`, and the package's exports do not gain it (`packages/llms/src/index.ts:18` re-exports `openrouter.js`, which does not re-export `profiles.ts`).
- `modelNameIcon` serves the `openai` kind on a compatible endpoint (§3). The order decides names that hold two words. A distilled model names its teacher first and its student last (`deepseek-r1-distill-qwen`, `deepseek-r1-distill-llama`), so `deepseek` comes before `qwen` and `llama` and such names wear DeepSeek. `gpt` comes before them, so `gpt-oss` wears OpenAI. The words do not overlap one another (`gemma` and `gemini` share only `gem`). A substring match also gives `codellama` Meta, `codegemma` Gemma and `chatgpt-4o` OpenAI.
- An icon added to the set for a model family is one row of `modelFamilies`, and both rules then use it (D9).

#### The record

`packages/llms/PROVENANCE.md`, written like the fonts section of `packages/desktop/PROVENANCE.md:124-129`. It states:

- the package, version, tarball URL, integrity and `gitHead` (see [Terms](#icons));
- each icon's source file, its SHA-256 and size in the tarball, and the SHA-256 and length of the stored value:

  | Key          | Source                 | Source SHA-256                                                     | Bytes | Stored SHA-256                                                     | Length |
  | ------------ | ---------------------- | ------------------------------------------------------------------ | ----- | ------------------------------------------------------------------ | ------ |
  | `claude`     | `icons/claude.svg`     | `365a70a7eb3956d9b9a96086058ebe04e1dbd8e291a756ad964e8a283fbd6d38` | 1701  | `31b0c68dec9e9886c4aa34e1a5c7fa9443f1a8cef915f2c00bc3b4ef175f0939` | 1623   |
  | `deepseek`   | `icons/deepseek.svg`   | `8f9443e351b6dacce71871790201b799d92e8bf96a45ef79aeb5e9bf4db423e2` | 2189  | `9d56e83c9f27247203261f51fd6328bd68116e6a8834fbfb1ef98b4b99023709` | 2109   |
  | `gemini`     | `icons/gemini.svg`     | `87d5b3c4be75a66f54c1936482a263df68185545b741129badd1b7c2449c18d3` | 651   | `b5a5c2da1e6738e028b9ec351c58806b055da614e9163060826b5d755cca11db` | 573    |
  | `gemma`      | `icons/gemma.svg`      | `8f9b74f6bbbf17203da8d81c3a4bb8750dbf13afe3ab4c1d482e84be62cd03a6` | 2078  | `e086675c1aab725e1034d4094c195a4bccecb5f2c9bd246171432a95fbd10c00` | 2001   |
  | `meta`       | `icons/meta.svg`       | `805ef9a35305393eb5a89be46b0708c9b119b3308ca44aaedd1457ff04857060` | 1735  | `ab40fb1b971a22242cb9a2c8e41c62d6be56f96ef9bd4505c297b82799ef00a6` | 1659   |
  | `openai`     | `icons/openai.svg`     | `a595df6b423920c67a7f8f73c063e4bfb72d415948097b6cac063a2366bb5186` | 1687  | `e8825f28f5e762f7005b90e5d10301d0a61606aed3eebf1715c485702d160023` | 1609   |
  | `openrouter` | `icons/openrouter.svg` | `ae671cc83de9bd45db97a47ed5e38a4e1bd9f93a12be495ba4b4f8b284026bca` | 382   | `d7ab11810a3596cd8e82a1bd74b831c71b0762a0e43550793ccdfaa87db0df5f` | 300    |
  | `qwen`       | `icons/qwen.svg`       | `b2c16efc3bd32b88a941842d41222e1e1e0e40441222218b725afc0aef6d9a36` | 1041  | `ed914b0a1de0d9df60f3c47db508e01a6d49270b5ac890d6f97192ced320ec7c` | 965    |

- the three replacements above, verbatim;
- how to check the module: `npm pack @lobehub/icons-static-svg@1.102.0`, `tar -xzf` the tarball, hash each source file (`sha256sum package/icons/<key>.svg`), and hash each value of `lobehub.ts` — the text between the single quotes after `<key>: ` — against the stored column;
- how to upgrade: pack the new version, repeat the replacements for every key, replace each value, and replace the table, the version, the URL, the integrity and the `gitHead` in one change;
- that the tarball has no LICENSE file and the text below is the repository's `LICENSE` at `gitHead` `989535d6c13da2dec5a2937fe2789d4af4fdd8e0`;
- the MIT license text verbatim, with `Copyright (c) 2023 LobeHub`;
- that the marks are the trademarks of their owners, used to name the vendor of a model.

No generation path exists for this module. HC-008 then asks to "explain why the artifact changed": a change to the module comes with a change to `PROVENANCE.md` that names the new source and its hashes.

### 3. Provider bundles

`KindDefinition` (`bundles/providers/*/src/host/provider.ts:31-46`) gains:

```ts
/** A kind's choice of icons, by name; `models` has the input's length and order. */
export interface KindIcons {
  readonly provider?: ModelIconName;
  readonly models: readonly (ModelIconName | null)[];
}

  /** The icons this kind chooses for a provider's values and some of its models. */
  readonly icons: (input: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly models: readonly string[];
  }) => KindIcons;
```

`createKindProvider` (`bundles/providers/openai/src/host/provider.ts:96-149`) adds, after `catalogCapacity`:

```ts
      icons: defineMethod({
        ...modelsProviderMethods.icons,
        execute: (input) => Promise.resolve(definition.icons(input)),
      }),
```

The same edit is made in all four copies of `provider.ts`. `openai`, `codex` and `openrouter` are byte-identical; `claude` differs only in `catalog`'s dependencies (`bundles/providers/claude/src/host/provider.ts:38-44,117-126`), where this edit does not reach. A `definition.icons` that throws makes the method reject; the core then gives that request no icon (D5).

Each `kind.ts` defines `icons`:

| Kind (file)                                                                       | `provider`   | `models[i]`                                   |
| --------------------------------------------------------------------------------- | ------------ | --------------------------------------------- |
| `claude` (`bundles/providers/claude/src/host/kind.ts:19-52`)                      | `claude`     | `claude` for every model                      |
| `codex` (`bundles/providers/codex/src/host/kind.ts:25`)                           | `openai`     | `openai` for every model                      |
| `openai` on OpenAI's endpoint (`bundles/providers/openai/src/host/kind.ts:11-37`) | `openai`     | `openai` for every model                      |
| `openai` on a compatible endpoint                                                 | none         | `modelNameIcon(model)` from `llms` (§2)       |
| `openrouter` (`bundles/providers/openrouter/src/host/kind.ts:29`)                 | `openrouter` | `openRouterModelIcon(model)` from `llms` (§2) |

The `openai` rule, in `bundles/providers/openai/src/host/kind.ts`. The endpoint is the provider value `endpoint`, the key `endpointField` declares (`bundles/providers/openai/src/host/provider.ts:176-184`); it is compared with the kind's default base URL, which the file already imports (`bundles/providers/openai/src/host/kind.ts:1,18`; `packages/llms/src/lib/providers/openai.ts:64-68`):

```ts
const openAiOrigin = new URL(openAiMetadata.baseUrl);

/** Whether an `openai` provider talks to OpenAI itself rather than a compatible server. */
const isOpenAiEndpoint = (endpoint: string | undefined): boolean => {
  const value = (endpoint ?? '').trim();
  if (value === '') return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === openAiOrigin.protocol &&
      url.hostname === openAiOrigin.hostname
    );
  } catch {
    return false;
  }
};

// in openAiKind:
  icons: ({ configuration, models }) =>
    isOpenAiEndpoint(configuration.endpoint)
      ? { provider: 'openai', models: models.map(() => 'openai') }
      : { models: models.map(modelNameIcon) },
```

- An absent `endpoint` and a blank one are OpenAI's: a new provider's draft starts with every value empty (`bundles/desktop/settings/src/client/domain/config.ts:847-852`), and an empty field shows OpenAI's URL as its placeholder (`bundles/providers/openai/src/host/provider.ts:183`). A host that only starts with `api.openai.com` (`https://api.openai.com.example.test`) and a value that is not a URL are compatible endpoints.
- The matching order of compatible names is the order of `modelFamilies` (§2).

The other three kinds write their constant rows the same way, as `icons: ({ models }) => ({ provider: '<name>', models: models.map(() => '<name>') })`; `openrouter` writes `models: models.map(openRouterModelIcon)`.

### 4. Core: `models/v1.icons`

New module `bundles/foundation/core/src/host/models/icons.ts`, wired in `bundles/foundation/core/src/host/models/index.ts` after `contextWindow` and `inputModalities` (`bundles/foundation/core/src/host/models/index.ts:163-170`), as the last method of the `models/v1` service. It shares nothing with them: they read a built provider's cached catalog through `catalogModel` (`bundles/foundation/core/src/host/models/capacity.ts:28-65`), which calls `cache.resolve`, while `icons` reads only `registry.find` and `cache.configured()` and never resolves a provider:

```ts
    icons: defineMethod({
      ...modelsMethods.icons,
      execute: (input) => modelIcons(registry, cache, input),
    }),
```

```ts
/** How long the core waits for one provider record's `icons`. */
export const PROVIDER_ICONS_DEADLINE_MS = 1000;

/**
 * A record's choice, or `undefined` when it rejects, does not answer within
 * the deadline, or answers another number of models (D5).
 */
const iconsOf = async (
  api: ModelsProvider,
  input: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly models: readonly string[];
  },
  deadlineMs: number,
): Promise<ModelIconChoice | undefined>;

export const modelIcons = (
  registry: Pick<KindRegistry, 'find'>,
  cache: Pick<ProviderCache, 'configured'>,
  input: { readonly requests: readonly ModelIconRequest[] },
  options?: { readonly deadlineMs?: number },
): Promise<ModelIconAnswers>;
```

`iconsOf` catches like `capacityOf`, the wrapper that turns a rejecting `catalogCapacity()` into "no capacity" (`bundles/foundation/core/src/host/models/registry.ts:26-36`). It waits through `bounded(() => api.icons(input), deadlineMs)`, the helper the core already uses to wait for a hook handler (`bundles/foundation/core/src/shared/hooks.ts:81-107`, called at line 439); a result equal to its `timedOut` symbol means no answer in time. `bounded` and `timedOut` are exported from that module for this, unchanged. `deadlineMs` defaults to `PROVIDER_ICONS_DEADLINE_MS`; tests pass a shorter one.

For each request, in parallel:

1. **Target.** A `{ kind, configuration }` request is its own target. A `{ providerId }` request takes the provider with that id from `cache.configured()` (`bundles/foundation/core/src/host/models/providers.ts:163`) and uses its kind and provider values; no such provider → no target.
2. **Record.** `registry.find(kind)` (`bundles/foundation/core/src/host/models/registry.ts:82`), which finds advertised and non-advertised kinds alike; none → no target.
3. **Ask.** `iconsOf(entry.api, { configuration, models }, deadlineMs)`; `undefined` → no target.
4. **Resolve.** A name for which `isModelIconName` (§2) is false counts as none. The answer's `provider` is the provider's own name, absent when none. Each `models[i]` is the model's name, else the provider's own name, else `null` (the fallback). A request without a target answers no `provider` and `null` per model.

`svgs` holds `modelIconSvg(name)` for every name the answers use, and no other. The method does not read `secrets/v1`, does not build providers and keeps no cache. It never rejects for an unknown provider, an unknown kind or a provider failure; input outside the schema is refused by the method's input validation, as for any method.

### 5. Drawing an icon: `svgMask` and the trust boundary

`packages/desktop/src/lib/utils.ts`, which today only re-exports `cn` (line 1) through the existing `desktop/ui/utils` export (`packages/desktop/package.json:74-79`), gains:

```ts
/**
 * The CSS image an SVG is drawn from as a mask: a `url("data:image/svg+xml,…")`
 * with the markup percent-encoded, so no character of it can end the quoted
 * URL. The SVG is decoded as an image, which runs no script and loads nothing.
 */
export const svgMask = (svg: string): string =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
```

Settings and the chat draw every icon through `svgMask`, set through React's `style` object or `CSSStyleDeclaration.setProperty`, never through `cssText` concatenation or `innerHTML`. The trust boundary:

- The SVGs are the eight values of §2. The bridge validates each answer against the contract's schema, which caps an SVG at `MODEL_ICON_MAX_LENGTH` characters and requires `<svg` at its start (§1).
- An SVG used as a CSS image is decoded as an image: no script runs and no external resource loads. The worst a hostile SVG can do is draw a shape in the icon's box.
- `encodeURIComponent` escapes `"`, `\`, `%`, `#`, line breaks and every non-ASCII character, so the value cannot leave the quoted `url("…")`. It leaves `(` and `)` as they are, which inside quotes cannot end the URL.
- The window's Content Security Policy allows `data:` images (`img-src 'self' data:` at `app/desktop/doric/src/platform/protocol/csp.ts:19,40`, and `img-src ${DORIC_ORIGIN} data: blob:` at line 53), and CSS masks load through `img-src`; the bot glyph is drawn this way today.

The chat's `AGENT_MARK` is built with `svgMask` (§10), so the chat keeps no copy of the encoding. Papercraft's two copies (`bundles/features/papercraft/src/client/surface/preview-container.tsx:113`, a cursor with a hotspot, and `bundles/features/papercraft/src/client/surface/avatar.tsx:40`, an `<img src>` without `url()`) are not this function's output and stay as they are.

`ProviderIcon`'s inline `<svg><path d=…/></svg>` (`bundles/desktop/settings/src/client/components/molecules/provider-icon.tsx:26-36`) goes with the hard-coded paths.

### 6. Settings: the execution picker

#### Domain

New module `bundles/desktop/settings/src/client/domain/model-icons.ts`:

```ts
/** What one provider is asked: its id (kept in the renderer), its kind, its values and some models. */
export type IconRequest = {
  readonly providerId: string;
  readonly kind: string;
  readonly configuration: Readonly<Record<string, string>>;
  readonly models: readonly string[];
};

/** The icons a surface draws, looked up by provider id. */
export type IconLookup = {
  readonly provider: (providerId: string) => string | undefined;
  readonly model: (providerId: string, model: string) => string | undefined;
};

export const noIcons: IconLookup;

/**
 * One request per provider, in configuration order: its listed model names,
 * then the execution model when that provider is the execution provider and
 * does not list it. Names longer than `MODEL_ICON_MAX_NAME` are left out
 * (their rows draw no icon); only the first `MODEL_ICON_MAX_MODELS` names
 * are asked for.
 */
export const modelIconRequests = (configuration: Configuration): readonly IconRequest[];

/** One request for a provider's own icon (no models), for the dashboard rows and the provider page. */
export const providerIconRequest = (provider: ProviderConfiguration): IconRequest;

/**
 * The lookup over answers and the requests they answered, index for index;
 * each name is read through `answers.svgs`. A provider id asked twice uses
 * its first request.
 */
export const iconLookupFrom = (
  requests: readonly IconRequest[],
  answers: ModelIconAnswers,
): IconLookup;
```

`ModelChoice` (`bundles/desktop/settings/src/client/domain/config.ts:296-299`) becomes `{ label; value; icon?: string }`. `modelGroups` (`bundles/desktop/settings/src/client/domain/config.ts:1468-1502`) becomes `modelGroups(configuration, icons: IconLookup = noIcons)`. Each listed choice takes `icons.model(provider.id, entry.name)`; the row it adds for an execution model that is not listed takes `icons.model(providerId, model)`, which is `undefined` when no provider has that id. A choice without an icon has no `icon` key. `searchModelGroups` (`bundles/desktop/settings/src/client/domain/config.ts:1511-1525`) keeps choice objects as they are, so it keeps their icons. The lookup is an argument rather than a merge in `ExecutionPicker` because `modelGroups` alone knows which provider a choice belongs to, including the added row; a merge afterwards would split the composite key (`bundles/desktop/settings/src/client/domain/config.ts:1649-1650`) again.

#### Adapter

`SettingsApi.providers` (`bundles/desktop/settings/src/client/api/settings-api.ts:1002-1005`) gains:

```ts
    /** Each request's icons; an empty list answers `{ svgs: {}, answers: [] }` without a host call. */
    icons(requests: readonly IconRequest[]): Promise<ModelIconAnswers>;
```

The implementation (beside `kinds` and `models`, `bundles/desktop/settings/src/client/api/settings-api.ts:1065-1086`) sends all requests in one call, as `{ requests: [{ kind, configuration, models }] }` without `providerId`, through `reach` — the adapter's wrapper that turns a host error into its messages (`bundles/desktop/settings/src/client/api/settings-api.ts:110-118`) — as `reach(() => services.use(ModelsV1).icons(input))`, with no deadline, as `kinds`, `models` and `catalog` call the host. More than `MODEL_ICON_MAX_REQUESTS` providers make the host refuse the call, and the surface shows no icons ([Risks](#risks), R8).

A guard `iconAnswersFrom(value, requests)`, written like `catalogFrom` (`bundles/desktop/settings/src/client/api/settings-api.ts:861`), answers the value as `ModelIconAnswers` and fails with `invalidResponse()` (`bundles/desktop/settings/src/client/api/settings-api.ts:86`) when the value is not an object, `svgs` is not a record of strings each starting with `<svg` and at most `MODEL_ICON_MAX_LENGTH` long, `answers` has another length than `requests`, an answer's `models` has another length than its request's, or a name is not an own key of `svgs`. `iconLookupFrom` therefore receives only answers that match their requests.

#### Hook

New `bundles/desktop/settings/src/client/hooks/use-model-icons.ts`:

```ts
/**
 * The icons the host answers for these requests, or `undefined` until the
 * first answer arrives. A change of the requests asks again at once, and the
 * previous icons stay until the new answer replaces them. A failure answers
 * `noIcons`: an icon is never an error the reader has to act on.
 */
export const useModelIcons = (requests: readonly IconRequest[]): IconLookup | undefined;
```

- It calls `useQuery({ queryKey: queryKeys.modelIcons(requests), queryFn: async () => ({ requests, answers: await api().providers.icons(requests) }), staleTime: Infinity, placeholderData: keepPreviousData, enabled: requests.length > 0 })`, written like `useProviderKinds` (`bundles/desktop/settings/src/client/hooks/use-provider-kinds.ts:36-48`) with two options that hook does not set and no Settings code uses yet: `placeholderData: keepPreviousData` (TanStack Query 5) and `enabled`. The lookup is built from the data's own `requests`, so a kept previous answer is read against the requests it answered. With no requests it answers `noIcons`.
- `queryKeys` (`bundles/desktop/settings/src/client/queries/keys.ts:7-24`) gains:

  ```ts
    /** The icons of the providers and models a surface draws, keyed by what it asked. */
    modelIcons: (requests: readonly IconRequest[]) => ['providers', 'icons', requests],
  ```

#### Components

- New molecule `bundles/desktop/settings/src/client/components/molecules/model-icon.tsx`: `ModelIcon({ svg?, inlineStart?, className? })` draws `<span aria-hidden="true" data-slot="model-icon">` of `size-4 shrink-0` (16px, U2). With an SVG it adds `bg-current` and a `style` whose `mask` and `WebkitMask` are both `svgMask(svg) + ' center / contain no-repeat'`; without one it is an empty slot of the same size. `inlineStart` sets `data-icon="inline-start"`, so a `Button` pads for it as for a leading icon, as P1 does.
- `ChoiceList` (`bundles/desktop/settings/src/client/components/molecules/choice-list.tsx:5-17`): each choice gains `readonly icon?: string`, and the props gain `readonly iconSlot?: boolean` (default `false`). With `iconSlot`, every row draws `<ModelIcon svg={choice.icon} />` first inside the label span (`bundles/desktop/settings/src/client/components/molecules/choice-list.tsx:46`). Without it, rows are unchanged, so the effort rows get no icon and no slot.
- `ModelPicker` (`bundles/desktop/settings/src/client/components/molecules/model-picker.tsx:24-35`) gains `readonly icon?: string`, the selected model's icon. The trigger draws `<ModelIcon svg={icon} inlineStart />` before its label (`bundles/desktop/settings/src/client/components/molecules/model-picker.tsx:78`) only when `icon` is defined; the trigger keeps no empty slot. The model lists pass `iconSlot` (`bundles/desktop/settings/src/client/components/molecules/model-picker.tsx:114-121`).
- `ExecutionPicker` (`bundles/desktop/settings/src/client/components/organisms/execution-picker.tsx:24-99`) calls, before its early return at line 29, `useModelIcons(useMemo(() => (draft === undefined ? [] : modelIconRequests(draft)), [draft]))`. It passes the result (or `noIcons` while `undefined`) to `modelGroups` (line 36) and passes `icon={model === '' ? undefined : icons.model(providerId, model)}` to `ModelPicker` (lines 61-73). The plain `Input` shown without choices (lines 74-85) draws no icon.

### 7. Settings: the provider pages

- `ProviderIcon` (`bundles/desktop/settings/src/client/components/molecules/provider-icon.tsx`) becomes `ProviderIcon({ svg, className })` with `svg: string | null | undefined`: a string draws `<ModelIcon svg={svg} className={className} />`; `null` (the host answered no icon) draws `<ServerIcon aria-hidden className={className} />` from lucide (U9); `undefined` (no answer yet) draws `<ModelIcon className={className} />`, an empty slot of the same size.
- `DashboardProvidersGroup` (`bundles/desktop/settings/src/client/components/organisms/dashboard-providers.tsx:32-95`) calls `useModelIcons` with `providerIconRequest` for each provider of `draft` (none while `draft` is `undefined`), and each row draws `ProviderIcon` with `svg = icons === undefined ? undefined : (icons.provider(provider.id) ?? null)` and `className="size-3.5"`. The row's `[&_svg]:size-3.5` (line 76) sizes only the `ServerIcon`, so the mask span takes the class directly.
- `DashboardProviderPage` (`bundles/desktop/settings/src/client/components/organisms/dashboard-provider-page.tsx:25-90`) calls `useModelIcons` with `[providerIconRequest(draft)]`, or `[]` while `draft.kind` is empty, and draws the header's `ProviderIcon` (lines 53-57) the same way with `className="size-4 shrink-0"`. A draft not saved yet (`id: ''`) is asked for by its kind and values like any other, so a new `openai` provider shows OpenAI until its endpoint names a compatible server, and then `ServerIcon`.
- Deleted: `bundles/desktop/settings/src/client/components/molecules/provider-icon-paths.ts`, and, in `bundles/desktop/settings/src/client/domain/provider-icon.ts`, `localHosts`, `isLocalEndpoint`, `ProviderMark`, `brandMarks`, `isBrandMark` and `providerMark` (lines 1-46) with the file's header comment (lines 1-2). `providerSite` and its `sites` table (lines 48-58) stay unchanged, and `dashboard-provider-page.tsx:13` keeps its import.

### 8. Chat: which model answered a turn

#### How a prompt becomes turns

The chat draws a thread from its durable log. The reader's message is a **prompt**: a job with a `promptId`, which the host accepts, starts, runs and finishes. While it runs, the **run** — the agent working on that prompt — writes events: `agent.started` once, then for each **response** of a model a `response.started` and its text, reasoning and tool-call deltas, then tool results that lead to the next response, and finally `prompt.finished`. The **projector** (`bundles/desktop/chat/src/client/domain/projector.ts`) folds the log into **turns**: a user turn for the prompt, then, in log order, thinking turns, tool-call turns and agent turns (the user-visible text), all with the prompt's `promptId` (`bundles/desktop/chat/src/client/domain/projector.ts:44-53`). One prompt therefore has several responses and several agent turns. The **sync** (`bundles/desktop/chat/src/client/components/organisms/conversation/plugins/insert-thread-turn-nodes.tsx`) writes each turn into the Lexical editor as a **turn block**; a block with its author line is a **unit** (`TurnUnit`). The **author line** names who wrote a run: the reader on each user turn, the agent on the last turn of a run, before the next user turn (`authorFor`, `bundles/desktop/chat/src/client/domain/conversation-sync.ts:49-89`). A user turn that a bundle gave as an instruction wears an agent author named after the bundle (lines 77-81). The **gutter mark** is planned apart from the line (`markFor`, `bundles/desktop/chat/src/client/domain/conversation-sync.ts:100-123`, type `AuthorMark`, `bundles/desktop/chat/src/client/domain/conversation-authors.ts:25-33`). A user turn wears the mark of its author line, so the reader's turn wears the reader's and a bundle's instruction an agent mark named after the bundle (lines 111-114). The agent wears one mark per **stretch**, its work between two user turns the reader or a bundle sent, on the stretch's first agent turn (lines 115-122); an input relayed from another Thread or a background terminal does not start a stretch (`isRelayedInput`, lines 91-98), and the stretch's tool calls, spawns, relayed inputs and later answers wear none. The sync passes each step's `mark` to `$syncAuthor`, which sets the block's avatar from it (`insert-thread-turn-nodes.tsx:259-268`); only user and agent turn blocks draw one (lines 267-268).

#### The answering model

`response.started` carries `providerId` and `model` once per model response (`bundles/runtime/default/src/host/executor.ts:549-559`); its `model` is the requested name (`packages/llms/src/lib/providers/openrouter.ts:114`, `packages/llms/src/lib/providers/claude.ts:191`, `packages/llms/src/lib/providers/openai.ts:169`). `agent.started` carries only `model` and comes once per run (`packages/agent/src/lib/agent.ts:507-511`). The projector reads `response.started`.

In `bundles/desktop/chat/src/client/domain/conversation-authors.ts`, which the sync imports and the projector will import for this type; it imports nothing from either (its only import is the re-export of `READER_NAME` from `../../contracts/index.js`, line 10), so the projector's import makes no cycle:

```ts
/** The model that answered a turn, as the runtime recorded it. */
export type AnsweredBy = {
  readonly providerId: string;
  readonly model: string;
};
```

In `bundles/desktop/chat/src/client/domain/projector.ts`:

- `AgentTurn` (lines 108-115) and the `agent` variant of `Draft` (lines 303-309) gain `answeredBy?: AnsweredBy`.
- `Projection` (lines 240-268) gains `readonly answers: ReadonlyMap<string, AnsweredBy>`: per prompt id, the latest answering model read so far.
- `readEvent` (from line 638) takes `answers: Map<string, AnsweredBy>` after `users`, and gains a branch: on `event?.type === 'response.started'`, when `event.providerId` and `event.model` are non-empty strings it sets `answers.set(promptId, { providerId, model })`, otherwise it deletes the prompt's entry. The branch opens no turn and pushes the event into no turn.
- The two places that push an `agent` draft — on `text.delta` (line 747) and on `prompt.finished` (line 799) — add `answeredBy: answers.get(promptId)` when that entry exists. A turn keeps the model it was opened with; a later response of the same prompt stamps only the agent turns opened after it.
- `project` (lines 968-1006) creates `answers` as a new `Map`; `readInto` (lines 1008-1058) copies it (`new Map(current.answers)`) and returns it; `emptyProjection` (lines 1160-1169) adds `answers: new Map()`.

Only an `AgentTurn` carries the field. The agent's mark is always on an `AgentTurn` (`markFor` answers an agent mark only for one, `bundles/desktop/chat/src/client/domain/conversation-sync.ts:115-122`), so its icon is that of the model that answered the turn wearing it: the stretch's first answer (U4, §10). A later answer of the same stretch wears no mark, whichever model gave it.

### 9. Chat: fetching icons

#### The handle

- `bundles/desktop/chat/manifest.json:17`: `optional` gains `"models/v1"`.
- `bundles/desktop/chat/src/client/index.ts` adds, beside the other optional providers (lines 104-119), `const models = services.whenAvailable(ModelsV1, (api) => { setModelsApi(api); return () => setModelsApi(undefined); });` and disposes it in the returned cleanup.
- The handle is known before the chat draws anything. The window registers every host contract it may call (`catalog.remote`) in its service directory (`packages/desktop/src/client/activate.ts:223-227`) before it activates the bundles' client parts (`packages/desktop/src/client/activate.ts:240`), and `whenAvailable` reports each provider already registered synchronously, inside the call (`packages/bundle/src/runtime/directory.ts:132-142`). So when the chat's `activate` returns, the handle is set if the host exposes `models/v1`, and "no handle" means the host has none.

#### The read

New module `bundles/desktop/chat/src/client/api/model-icons.ts`:

```ts
/** The `models/v1` handle while the host provides it. */
export const setModelsApi = (api: Pick<Models, 'icons'> | undefined): void;

/**
 * The SVG of one answering model's icon (its own, else its provider's own), or
 * `null` when the icon is known to be absent: no handle, the window's own
 * stub refusing a `models/v1` without `icons`, or an answer that names none.
 * Rejects for every other failure, `unavailable` from the bridge included.
 */
export const readModelIcon = (providerId: string, model: string): Promise<string | null>;
```

`readModelIcon` is `async`, so a stub that throws synchronously rejects. It calls `icons({ requests: [{ providerId, models: [model] }] })`, with no deadline, as the chat's other host calls, and answers `svgs[name]` for the name `answers[0].models[0]` when that name is an own key of `svgs`, `null` otherwise.

`unavailable` alone does not mean "no icon exists": the runtime also throws it when the caller is no longer active (`packages/bundle/src/runtime/dispatch.ts:128-133`), when a link or process channel is closed (`packages/bundle/src/runtime/envelope/link.ts:777,789`, `packages/bundle/src/process/node-transport.ts:8`), and when no generation is active or the host is stopping (`packages/bundle/src/process/manager.ts:507,521,573`); Settings reads it as "host not reached" (`bundles/desktop/settings/src/client/api/settings-api.ts:89-94`). So `readModelIcon` answers `null` for one rejection only: a `ContractError` (`isContractError`, `packages/bundle/src/contracts/error.ts:79`) with code `unavailable` and `details` deep-equal to `{ contract: 'models/v1', method: 'icons' }`. That is the error the window's stub throws itself, without a bridge call, when the remote record of `models/v1` has no `icons` method (`packages/bundle/src/runtime/dispatch.ts:163-168`); the record's methods are the ones the host's catalog lists (`packages/desktop/src/client/bridge.ts:125-130`), so this happens exactly when the host's `models/v1` is older than 1.3.0. An error the bridge relays carries only a code and a message, so an `unavailable` from the host never matches and is passed on as a failure. `setModelsApi` stores the handle and calls `chatQueryClient.invalidateQueries({ queryKey: ['models', 'icon'] })`, so a handle that arrives after activation repaints the marks.

#### The queries

- `bundles/desktop/chat/src/client/queries/keys.ts` gains `modelIcon: (providerId: string, model: string) => ['models', 'icon', providerId, model]`.
- In `bundles/desktop/chat/src/client/components/organisms/conversation/nodes/turn-avatar.ts`, beside `TurnAvatar`:

  ```ts
  /** An agent mark's icon: the SVG, the bot glyph (no icon exists), or nothing yet. */
  export type AgentMarkIcon =
    | { readonly kind: 'icon'; readonly svg: string }
    | { readonly kind: 'fallback' }
    | { readonly kind: 'pending' };

  /** The icon of each answering model the turns name, by `answeredKey`. */
  export type AgentIcons = ReadonlyMap<string, AgentMarkIcon>;

  /** `${providerId}\u0000${model}`. */
  export const answeredKey = (answered: AnsweredBy): string;
  ```

- New hook `bundles/desktop/chat/src/client/hooks/use-agent-icons.ts`, which exports only `useAgentIcons(turns: readonly Turn[]): AgentIcons`. It collects the distinct `answeredBy` of the agent turns and runs `useQueries` with one query per pair: `queryKey: queryKeys.modelIcon(providerId, model)`, `queryFn: () => readModelIcon(providerId, model)`, `staleTime: Infinity`, `gcTime: Infinity` (TanStack Query 5 drops an unused query after 5 minutes by default; this keeps answers for the window's life, D10), and the client's other defaults: no retry, as the chat's query client decides for a local host that "answers once" (`bundles/desktop/chat/src/client/queries/client.ts:3-6,12`). The core already bounds each provider (§4), so a failure left here is the bridge's, which a retry would not mend.
- States: a string maps to `icon`; `null` to `fallback`; a pending query and a failed one map to `pending`, so a failure leaves the mark empty, as U11 asks for an icon not known to be absent. A failed query has no data, so the query client fetches it again when the conversation is mounted again. The `queryFn` answers `null`, not `undefined`, for "none", because a query function may not resolve to `undefined`.
- The returned map keeps its identity across renders until some entry's state changes (memoized on a string built from each key and state), so the sync does not run again when nothing changed.
- The conversation (`bundles/desktop/chat/src/client/components/organisms/conversation/index.tsx:377-380`) calls `useAgentIcons(turns)` and passes the result to `InsertThreadTurnNodes` as `agentIcons` (lines 439-447).

### 10. Chat: the mark

#### `TurnAvatar`

`TurnAvatar` (`bundles/desktop/chat/src/client/components/organisms/conversation/nodes/turn-avatar.ts:43-47`) becomes:

```ts
export type TurnAvatar =
  | { readonly role: 'user'; readonly name: string }
  | {
      readonly role: 'agent';
      readonly name: string;
      readonly icon: AgentMarkIcon;
    }
  | null;
```

- `AGENT_FACE` and `AGENT_RING` (lines 23-33) are deleted. `AGENT_MARK` (lines 35-41) keeps its name and its SVG; it is the bot glyph of the `fallback` state, its doc comment says so, and it is built as `svgMask(…)` in place of its inline `url("data:image/svg+xml,…")` (line 39).
- `sameTurnAvatar` (lines 59-64) also compares, for two agent avatars, the icon's `kind` and, for `icon`, its `svg`.
- `applyTurnAvatar` (lines 73-93) still first clears `data-turn-avatar`, `data-avatar-initials`, `--turn-avatar-tone` and `--turn-avatar-ring`, and now also `--turn-avatar-icon`; its code that sets `--turn-avatar-face` and `--turn-avatar-mark` is deleted. For an agent it then sets `data-turn-avatar="agent"` and `--turn-avatar-icon` to `svgMask(icon.svg)` for `icon`, to `AGENT_MARK` for `fallback`, and to `svgMask('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>')` (an empty mask: nothing painted, the box kept) for `pending`. The reader's branch is unchanged.
- The nodes keep serializing their avatar as they do (`bundles/desktop/chat/src/client/components/organisms/conversation/nodes/agent-turn-node.tsx:305-325`, `bundles/desktop/chat/src/client/components/organisms/conversation/nodes/user-turn-node.tsx:192`); an agent avatar now includes its icon. No code persists agent-turn JSON: the chat's only `toJSON()` call reads the user prompt node (`bundles/desktop/chat/src/client/components/organisms/conversation/plugins/edit-queue-prompt.tsx:116-121`).

#### Sync

The icon travels with the mark, not with the author line: the line trails a stretch's last turn, which may be a tool call or a later answer, while the mark sits on its first answer.

- `AuthorDraft` (`bundles/desktop/chat/src/client/domain/conversation-authors.ts:19-23`) and `authorFor` (`bundles/desktop/chat/src/client/domain/conversation-sync.ts:58-89`) are unchanged.
- `AuthorMark` (`bundles/desktop/chat/src/client/domain/conversation-authors.ts:30-33`) gains `readonly answeredBy?: AnsweredBy`, and its doc comment says that an agent mark carries the model that answered the turn wearing it.
- `markFor` (`bundles/desktop/chat/src/client/domain/conversation-sync.ts:108-123`) returns at line 122 `turn.answeredBy === undefined ? { role: 'agent', name: AGENT_NAME } : { role: 'agent', name: AGENT_NAME, answeredBy: turn.answeredBy }`; `turn` is the `AgentTurn` at `index`, the stretch's first answer. The user branch (lines 111-114) still copies only `role` and `name` from `authorFor`, so a bundle instruction's agent mark has no `answeredBy` and draws the bot glyph.
- `$syncAuthor(unit, draft, mark, agentIcons)` (`bundles/desktop/chat/src/client/components/organisms/conversation/plugins/insert-thread-turn-nodes.tsx:259-286`) builds the avatar from `mark` (lines 265-266): `null` for no mark; `{ role: 'user', name }` for a user mark; for an agent mark `{ role: 'agent', name, icon }` with `icon = mark.answeredBy === undefined ? { kind: 'fallback' } : (agentIcons.get(answeredKey(mark.answeredBy)) ?? { kind: 'pending' })`. Its handling of `draft`, the author line, is unchanged. Both calls pass `agentIcons` (lines 803 and 830-834).
- `InsertThreadTurnNodes` (lines 687-707) gains the prop `agentIcons: AgentIcons`. The `syncedTurns` entry (lines 711-721), which already holds `markRole`, gains `markIcon: string | null`: for an agent mark the icon's `svg`, or its `kind` for the other two states; `null` for a user mark or none. The skip check (lines 787-799) also requires `last.markIcon === nextMarkIcon`, and both writes of the entry (lines 806-811, 837-842) store it. `agentIcons` joins the effect's dependencies (lines 891-900), so icons that arrive later repaint the marks of turns that did not change.
- `turnEquals` (from line 288) compares, in its `agent` case (lines 293-296), `answeredBy?.providerId` and `answeredBy?.model` as well, so the skip check never keeps a block whose turn's answering model changed.
- The prompt and the composer's stack keep `READER_AVATAR` (`insert-thread-turn-nodes.tsx:525,551`, `bundles/desktop/chat/src/client/components/organisms/conversation/nodes/composer-stack-node.tsx:53`).

#### CSS

In `bundles/desktop/chat/src/client/styles.css`:

- The shared box rule (lines 217-231) selects `[data-turn-avatar='user']::after` and `[data-turn-avatar='agent']::after` and keeps position, inset, size (1.375rem), `display: grid`, `place-items`, `font-size`, `line-height` and `user-select`. `border` and `border-radius` leave it.
- The user rule (lines 233-237) gains `border: 1px solid var(--turn-avatar-ring)` and `border-radius: 25%`.
- The agent face rule (lines 239-246) is deleted.
- The agent rule (lines 248-261) keeps `content: ''` and `pointer-events: none`, drops its own box declarations (now shared), and paints the icon centered at 18px (U8):

  ```css
  background-color: var(--foreground);
  mask: var(--turn-avatar-icon) center / 1.125rem no-repeat;
  -webkit-mask: var(--turn-avatar-icon) center / 1.125rem no-repeat;
  ```

- The moved-mark rule (lines 263-286) drops the `[data-turn-avatar-moved][data-turn-avatar='agent']::before` selector (lines 278-280); `[data-turn-avatar-moved][data-turn-avatar]::after` (specificity 0,4,1) still beats the agent rule (0,3,1), so a moved mark hides.
- The narrow-pane rule (lines 300-304) is unchanged: the box does not move.
- The comments at lines 194-205 and above each changed rule are rewritten to say that both marks are the block's `::after` and that the agent's is the answering model's icon.

### 11. The reader's marks as squares

- Gutter: the user `::after` rule's `border-radius: 25%` (§10) covers sent turns, the prompt and the composer's stack, which all wear `data-turn-avatar="user"`.
- `ReaderAvatar` (`bundles/desktop/chat/src/client/components/molecules/reader-avatar.tsx:14-15`): `rounded-full` becomes `rounded-[25%]`. Its five call sites (`comment-line.tsx:136`, `comment-thread-pin.tsx:125`, `prompt-author.tsx:19`, `thread-nav-rail.tsx:254`, `organisms/comment-entry.tsx:453`) do not change.

## Flows

**Picker opens.** `ExecutionPicker` asks `providers.icons` for every provider of the draft with its models → the core asks each provider record for names, applies the fallback and adds the SVGs → `modelGroups` puts each model's icon on its choice → each model row draws its 16px icon or an empty slot; the trigger draws the selected model's icon before its name. Editing a provider's endpoint changes the requests; each change asks again, and the previous icons stay until the answer arrives.

**OpenRouter row for `acme/coder-7b`.** The provider answers `provider: 'openrouter'`, `models: [null]` → the core answers `openrouter` for the model → the row shows OpenRouter.

**Local `openai` provider.** The provider answers no own icon; `llama3.2` gets `meta`, `gemma3:12b` gets `gemma`, `gpt-oss:20b` gets `openai`, `phi4` gets `null` → the picker shows Meta, Gemma, OpenAI and an empty slot; the dashboard row shows `ServerIcon` (U9).

**Claude provider.** The provider answers `claude` as its own icon and for every model → the dashboard row, the page header and every model row show Claude (U10).

**A new conversation turn.** The runtime records `response.started { providerId: 'or', model: 'anthropic/claude-sonnet-4' }`, then text deltas → the projector opens an agent turn with `answeredBy` → `useAgentIcons` starts a query for the pair; the mark is empty → the answer arrives; the sync repaints the mark with the Claude icon at 18px.

**A failed read.** The bridge rejects the call for a pair → the query fails, with no retry → the mark stays empty → the query is fetched again when the conversation is mounted again.

**An old log, or a provider removed since.** No `providerId` in `response.started` → no `answeredBy` → bot glyph. A `providerId` no longer in the active configuration → the core answers `null` → bot glyph.

**Host without `models/v1` 1.3.0, or without `models/v1`.** The window's stub refuses `icons` with `{ contract: 'models/v1', method: 'icons' }`, or no handle exists → `readModelIcon` answers `null` → bot glyph. An `unavailable` relayed from the host is a failed read (empty mark), not this case.

## Compatibility

- **Contract consumers.** Both contracts gain one method, a minor change for consumers (`docs/architecture/bundles/versioning.md:44`). Consumers that do not call `icons` keep their ranges: threads, host-config, transport and runtime/runtime keep `models/v1@^1.0.0`, usage keeps `^1.1.0` (`bundles/features/usage/manifest.json:12`), and runtime/default keeps `^1.2.0`, for `inputModalities` (`bundles/runtime/default/manifest.json:15`). Settings moves to `^1.3.0` because it calls `icons`. The chat takes `models/v1` as optional.
- **Providers of the two contracts: a breaking change.** Both are basic contracts, so a provider must implement exactly the method set of the platform it runs on (`packages/bundle/src/runtime/services.ts:45-63`). On a host whose `models.provider/v1` is 1.2.0, a record built against 1.1.0 has no `icons` and fails `provide` with `contract_mismatch`: it is never registered, and its kind, catalog and models disappear, not just its icon. The same holds for a replacement core's `models/v1`, as it already did when 1.2.0 added `inputModalities` (`packages/bundle/src/contracts/basic/models.ts:223-226`). This is accepted because every provider of both contracts is in this repository (the core, and `claude`, `codex`, `openai`, `openrouter`, `docs/architecture/bundles/contracts.md:89`), and all of them gain `icons` in phase 1; and because, before a published baseline, the repository refines basic contract shapes without a semver event (S-1, `docs/architecture/bundles/implementation-decisions.md:41`). `catalogCapacity` is in the same position: `models.provider/v1` has had it since the file's first commit (`96cbe110`), and a record without it fails the same check. The version stays a minor bump, as the versioning table classes a new method.
- **Old logs.** A `response.started` without `providerId` gives no `answeredBy`, and the mark is the bot glyph. The default runtime has recorded `providerId` since the file's first commit (`96cbe110`, 2026-10-18); logs from other runtimes are unverified.
- **Desktop exposure.** `models/v1` gains one desktop-exposed method; `app/backend/doric-host/tests/bridge-exposure.snapshot.json:46` becomes `["catalog", "icons", "kind", "kinds"]`, as its test requires for any exposure change (`app/backend/doric-host/tests/bridge-exposure.test.ts:1-5`).
- **Rollback.** By [phase](#phases): phase 3 (chat) and phase 2 (settings) revert independently. Phase 1 (host, `llms` and `svgMask`) reverts last: settings 1.4.0 requires `models/v1@^1.3.0` and does not activate against 1.2.0; the chat 1.6.0 keeps working against 1.2.0 and draws the bot glyph.

## Alternatives considered

| Alternative                                                                                            | Reason rejected                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two provider methods, `modelIcon` and `providerIcon`                                                   | Two envelope round trips per provider and two answers to merge, for data one pure function computes at once.                                                                                                                                                                                                                                                                                                      |
| A per-model provider method                                                                            | One envelope round trip per model: a picker with hundreds of models would make hundreds of calls.                                                                                                                                                                                                                                                                                                                 |
| Providers apply the fallback themselves                                                                | Four copies of the same rule, and the core could not tell a provider's own icon from a model's (the provider page needs the former).                                                                                                                                                                                                                                                                              |
| Providers answer SVG markup (version 1)                                                                | See §1, "Why names between provider and core".                                                                                                                                                                                                                                                                                                                                                                    |
| SVG markup and an open name space, so a provider outside the repository can bring a brand `llms` lacks | HC-004 asks not to add provider coupling before it is needed (`GROUNDING.md:3188-3192`), and no such provider exists; a later minor version can add an optional SVG to the provider's answer.                                                                                                                                                                                                                     |
| The SVG per model between core and renderer, without `svgs`                                            | The answer would grow with the number of models (up to 64 × 1000 per call); the dictionary bounds it by the eight icons.                                                                                                                                                                                                                                                                                          |
| Answering path data and a view box                                                                     | Loses `fill-rule`: all eight source files are `fill-rule="evenodd"` documents (`icons/<key>.svg` in the tarball).                                                                                                                                                                                                                                                                                                 |
| A second OpenRouter prefix table in the provider bundle (version 1)                                    | Duplicates `packages/llms/src/lib/providers/openrouter/profiles.ts:39-87`, and disagreed with it on `google/gemma`.                                                                                                                                                                                                                                                                                               |
| Separate `models/v1` methods for drafts and configured providers                                       | The same work with a different first step; one request union keeps one method and one batch.                                                                                                                                                                                                                                                                                                                      |
| A per-item `models/v1.icon`                                                                            | The picker would make one bridge call per model.                                                                                                                                                                                                                                                                                                                                                                  |
| Caching icons in the core                                                                              | Choosing icons is a pure function of strings with no I/O; a cache would save no I/O and would need invalidation when a provider record is replaced.                                                                                                                                                                                                                                                               |
| Keying the chat's request by `kind`                                                                    | The chat knows only a turn's `providerId` and model; the kind is not in the log.                                                                                                                                                                                                                                                                                                                                  |
| Keying the chat's request by the configuration revision as well (R4)                                   | The chat requires no configuration contract that reports the revision (`bundles/desktop/chat/manifest.json:18-29`), and every save would fetch every icon again.                                                                                                                                                                                                                                                  |
| Recording the icon in the log at run time                                                              | Puts SVG into durable history per response, and changes the runtime for a desktop concern.                                                                                                                                                                                                                                                                                                                        |
| Reading the model from `agent.started`                                                                 | It has no `providerId` and comes once per run (`packages/agent/src/lib/agent.ts:507-511`).                                                                                                                                                                                                                                                                                                                        |
| Stamping `answeredBy` on every turn type                                                               | Only agent and user turn blocks wear a mark (`insert-thread-turn-nodes.tsx:267-268`), and the agent's only on an agent turn (`conversation-sync.ts:115-122`); the other types would carry a field nothing reads.                                                                                                                                                                                                  |
| A generated stylesheet keyed by model, updated as icons arrive                                         | Builds CSS selectors from host data, which needs its own escaping, and splits the mark's state between the node and a sheet.                                                                                                                                                                                                                                                                                      |
| Drawing the bot glyph while an icon loads, or after a failed fetch                                     | The glyph says "no icon exists" (U11); a new conversation would show it before the icon.                                                                                                                                                                                                                                                                                                                          |
| Retries with backoff and a 5000 ms deadline on the chat's read (version 3)                             | The chat's query client turns retries off because the host is local and answers once (`bundles/desktop/chat/src/client/queries/client.ts:3-6,12`); the core already bounds each provider (§4), and a retry does not mend a bridge failure.                                                                                                                                                                        |
| A deadline on Settings' call (version 3)                                                               | No other Settings call to the host sets one (`kinds`, `models`, `catalog`), and the host bounds each provider (§4).                                                                                                                                                                                                                                                                                               |
| Waiting 500 ms after the last draft change before asking (version 3)                                   | Nothing measures the calls as a cost; it would need timer state Settings has nowhere else, and `keepPreviousData` already keeps the last icons on screen.                                                                                                                                                                                                                                                         |
| A `desktop/ui/svg-mask` export and a phase for it (version 3)                                          | `desktop/ui/utils` already exists for one-line helpers (`packages/desktop/package.json:74-79`); one more export path and phase buy nothing.                                                                                                                                                                                                                                                                       |
| A family table in the `openai` bundle beside the OpenRouter rule in `llms` (version 3)                 | Two tables of the same families; an icon added to the set would need two edits (U12, D9).                                                                                                                                                                                                                                                                                                                         |
| A Settings type for answers with names replaced by SVG (version 3)                                     | It copies each SVG once per model in the renderer, which D7 avoids on the wire; reading names through `svgs` needs no conversion.                                                                                                                                                                                                                                                                                 |
| Inserting the SVG as markup (`dangerouslySetInnerHTML`, an inline `<svg>`)                             | Runs host-supplied markup in the document; a mask decodes it as an image.                                                                                                                                                                                                                                                                                                                                         |
| SVGs as a `.svg` asset folder in `llms`                                                                | `llms` exports only TypeScript modules (`packages/llms/package.json:8-17`); assets would need new build and export wiring.                                                                                                                                                                                                                                                                                        |
| A new `packages/model-icons` package                                                                   | No second responsibility justifies a package (`GROUNDING.md:2846-2848`); every consumer already depends on `llms`.                                                                                                                                                                                                                                                                                                |
| A generator script, a hash record and a test for the icon module (version 1)                           | Three artifacts for eight static strings changed only on a deliberate upgrade; `PROVENANCE.md` holds the same hashes for a reviewer to check (§2).                                                                                                                                                                                                                                                                |
| `@lobehub/icons-static-svg` as a devDependency read at build time                                      | Adds a 2.5 MB, 996-file package (`npm view … dist.unpackedSize dist.fileCount`) and a lockfile change for eight files.                                                                                                                                                                                                                                                                                            |
| Settings takes `models/v1` as optional, as the chat does                                               | Settings already requires `models/v1` for kinds and catalogs (`bundles/desktop/settings/manifest.json:18`); a contract used with `services.use` enters `requires` with a range (`docs/architecture/bundles/versioning.md:35`), and a range below `^1.3.0` would admit a host without the method Settings calls. With `^1.3.0` a mismatched host fails at activation instead of drawing no icons without a reason. |
| Keeping `MonitorIcon` (lucide) for local endpoints                                                     | A renderer rule about endpoints, which U3 and U9 remove.                                                                                                                                                                                                                                                                                                                                                          |
| An empty slot on the provider pages when the host answers none                                         | U9 decides `ServerIcon`.                                                                                                                                                                                                                                                                                                                                                                                          |
| Moving `providerSite` to a file of its own                                                             | U3 keeps it; the move would change an import with no change in behavior.                                                                                                                                                                                                                                                                                                                                          |

## Risks

- **R1. Hostile or broken SVG.** Drawn only as a mask (§5): no script, no network, at most `MODEL_ICON_MAX_LENGTH` characters, a shape in the icon's box. The SVGs are the eight recorded in `PROVENANCE.md`.
- **R2. Trademarks.** The MIT license covers LobeHub's drawings; the marks remain their owners' trademarks. Owner: the user who approves this spec. Mitigation: each mark is drawn mono, unmodified, only next to the model or provider it names, and `PROVENANCE.md` says so; removing a mark is removing its key from the set and the rules that name it. This spec is not a legal review.
- **R3. Wrong family on compatible endpoints.** Name matching is a heuristic (§3): `deepseek-r1-distill-qwen` wears DeepSeek, `codellama` Meta, and a model renamed by its server (an Azure deployment named `prod-chat`) matches nothing and has no icon. The cost is a wrong or missing icon; the order of §3 decides every name that holds two words.
- **R4. Stale icons in the chat.** Answers are cached for the window's life. A provider id reused for another kind or endpoint shows the old configuration's icon on old and new turns of that pair until the window reloads. Accepted; keying by revision is rejected under [Alternatives](#alternatives-considered).
- **R5. Calls while typing in Settings.** Each change of a draft that touches providers asks again, so typing in an endpoint field makes one call per change (§6). Each call runs the kinds' rules on strings in the host with no I/O, and `keepPreviousData` keeps the last icons on screen until the answer replaces them. A half-typed endpoint that is not a URL counts as compatible, so an `openai` header can show `ServerIcon` until the URL is complete. No delay is added: nothing measures these calls as a cost.
- **R6. Renderer input reaching provider code.** `icons` runs each kind's pure function on strings the renderer sends, bounded to 64 requests, 1000 names each of at most 512 characters; provider values are as unbounded as for `catalog`, which is already exposed and takes the same `{ kind, configuration }` (`packages/bundle/src/contracts/basic/models.ts:208-214`). One call fans out to up to 64 provider calls in parallel, each given up after 1000 ms (§4); it reads no secret, builds no provider and does no I/O.
- **R7. A host that does not answer.** Neither Settings nor the chat sets a deadline, as none of their other host calls does; the host bounds each provider at 1000 ms (§4). A call the bridge never settles leaves Settings' slots empty (or showing the last icons) and the chat's mark empty. A failed chat read is fetched again when the conversation is mounted again.
- **R8. More than 64 providers.** The host refuses Settings' call, and Settings shows no icons. Accepted: the cost is missing icons, not an error.
- **R9. Settings activation.** With `models/v1@^1.3.0`, Settings does not activate against a host at 1.2.0. Both ship together in this repository.
- **R10. Hand-copied module.** Nothing checks `lobehub.ts` automatically. `PROVENANCE.md` gives the replacements and both hashes of each icon, so a reviewer checks every value with `sha256sum` against the table (§2).
- **R11. A provider that hangs.** It costs its own requests their icons after 1000 ms (§4); the rest of the call answers.

## Phases

Each phase leaves the code building and its tests passing.

1. **Host.** `models.provider/v1` 1.2.0 and `models/v1` 1.3.0 (§1); the `llms` icon set, names, OpenRouter rule and `PROVENANCE.md` (§2); the four providers (§3) and their manifests; the core's `icons` (§4) and its manifest; `svgMask` in `desktop/ui/utils` and its test (§5); `icons` in every hand-written fake of these contracts; the bridge-exposure snapshot. Settings and the chat do not call `icons` yet; Settings' fake host builds its `models/v1` from `modelsMethods` (`bundles/desktop/settings/tests/support/host.ts:71-89,105-112`), so it gains the method without a source change.
2. **Settings.** §6 and §7, `settings` 1.4.0 with `models/v1@^1.3.0`, its tests, stories and window-test staging.
3. **Chat.** §8 to §11, `chat` 1.6.0 with `models/v1` optional, its tests and stories.
4. **Docs.** [Docs to update](#docs-to-update).

## Files to change

### Phase 1

- `packages/bundle/src/contracts/basic/models.ts`: §1.
- `packages/bundle/tests/values.test.ts:144-159`: `icons: 'crosses'` under `models/v1` (after `inputModalities`, line 151) and `models.provider/v1`. The test states how each basic method crosses the envelope (`packages/bundle/tests/values.test.ts:65`); `'crosses'` means its input and output travel as plain data.
- `packages/bundle/tests/models.test.ts:69-95`: the `basicProvider` fixture answers `icons`.
- `packages/llms/src/lib/icons/lobehub.ts` (new, §2), `packages/llms/src/lib/icons/index.ts` (new), `packages/llms/src/index.ts`, `packages/llms/PROVENANCE.md` (new), `packages/llms/tests/icons.test.ts` (new, the behavior of `openRouterModelIcon`, `modelNameIcon` and `isModelIconName`).
- `bundles/providers/{claude,codex,openai,openrouter}/src/host/provider.ts`, `…/src/host/kind.ts`: §3. `…/manifest.json:4` 1.0.0 → 1.1.0 and `:7` `models.provider/v1@1.2.0`. `…/tests/provider.test.ts`: §3 tests.
- `bundles/foundation/core/src/host/models/icons.ts` (new), `bundles/foundation/core/src/host/models/index.ts`, `bundles/foundation/core/src/shared/hooks.ts` (`bounded` and `timedOut` exported): §4. `bundles/foundation/core/manifest.json:4` 1.12.0 → 1.13.0, `:18` `models/v1@1.3.0`; `bundles/foundation/core/src/host/models/capacity.ts` is unchanged. `bundles/foundation/core/tests/models.test.ts`: §4 tests.
- Hand-written `models/v1` fakes gain an `icons` method after their `inputModalities`, written as each writes that one: `bundles/runtime/default/tests/support/harness.ts:509-556` (`inputModalities` at lines 551-555) and `bundles/features/threads/tests/support/services.ts:125-170` (lines 165-169) as `defineMethod({ input: modelsMethods.icons.input, output: modelsMethods.icons.output, execute: () => ({ svgs: {}, answers: [] }) })`; `bundles/features/usage/tests/usage-service.test.ts:73-99` (lines 95-98) as `defineMethod({ ...modelsMethods.icons, execute: unexpected })`, the stub its tests use for methods they never call (line 60). Not edited: `bundles/runtime/runtime/tests/domain/support/harness.ts:282` builds its fake with `complete(modelsMethods, …)`, which defines every method of the spec (`bundles/runtime/runtime/tests/support/credentials.ts:41-55`), and `bundles/foundation/transport/tests/support/host.ts:161` with `fakeService(ModelsV1.id, modelsMethods, …)`, which does the same (`bundles/foundation/transport/tests/support/host.ts:82-97`).
- `app/backend/doric-host/tests/bridge-exposure.snapshot.json:46`.

- `packages/desktop/src/lib/utils.ts` (`svgMask`), `packages/desktop/tests/svg-mask.test.ts` (new): §5.

### Phase 2

- `bundles/desktop/settings/src/client/domain/model-icons.ts` (new), `domain/config.ts` (`ModelChoice`, `modelGroups`), `domain/provider-icon.ts` (the mark code removed, `providerSite` kept).
- `bundles/desktop/settings/src/client/api/settings-api.ts` (`providers.icons`, `iconAnswersFrom`).
- `bundles/desktop/settings/src/client/hooks/use-model-icons.ts` (new), `queries/keys.ts`.
- `bundles/desktop/settings/src/client/components/molecules/model-icon.tsx` (new), `choice-list.tsx`, `model-picker.tsx`, `provider-icon.tsx`, `provider-icon-paths.ts` (deleted).
- `bundles/desktop/settings/src/client/components/organisms/execution-picker.tsx`, `dashboard-providers.tsx`, `dashboard-provider-page.tsx`.
- `bundles/desktop/settings/manifest.json:4` 1.3.0 → 1.4.0, `:18` `models/v1@^1.3.0`.
- Tests: `tests/config.test.ts`, `tests/model-icons.test.ts` (new), `tests/icons-adapter.test.ts` (new), `tests/provider-icon.test.ts` (the mark cases deleted, the `providerSite` cases at lines 56-63 kept), `tests/client/dashboard-providers.test.ts:64-71,304-331`, `tests/client/execution-picker.test.ts` (new, with its footer probe, below), `tests/support/host.ts` (an `icons` handler in `FakeHost`), `tests/client/support/window.ts:51,57-60` (`icons: null` in the `models/v1` call shapes; `'models/v1': '1.3.0'` in `hostContractVersions`).
- Stories: `stories/support/host.tsx:175-190` (`icons` answering two fixture SVGs, a circle for every listed model and a square as each provider's own, and none for models starting with `acme/`), `stories/support/icons.ts` (new, the two fixtures), `stories/components/molecules/model-picker.stories.tsx`, `stories/components/organisms/execution-picker.stories.tsx` (states: icons, a row without an icon, icons pending). Stories use fixtures, not the vendored set, as stories seed providers with fixtures (`GROUNDING.md:1438-1439`).

### Phase 3

- `bundles/desktop/chat/src/client/domain/conversation-authors.ts`, `domain/projector.ts`, `domain/conversation-sync.ts`.
- `bundles/desktop/chat/src/client/api/model-icons.ts` (new), `index.ts`, `queries/keys.ts`, `hooks/use-agent-icons.ts` (new).
- `bundles/desktop/chat/src/client/components/organisms/conversation/index.tsx`, `plugins/insert-thread-turn-nodes.tsx`, `nodes/turn-avatar.ts`.
- `bundles/desktop/chat/src/client/styles.css`, `components/molecules/reader-avatar.tsx`.
- `bundles/desktop/chat/manifest.json:4` 1.5.1 → 1.6.0, `:17` `optional` gains `models/v1`.
- Tests: listed under [Test plan](#test-plan), including the generator change in `tests/projector-coalesced.property.test.ts`, the new `tests/client/model-icons.test.ts` and `tests/client/reader-avatar.test.ts`, and:
  - `tests/client/support/window.ts`: `openChatWindow` gains `readonly modelsV1?: '1.2.0' | '1.3.0'`. When given, the host candidate (lines 86-121) also provides `models/v1@<version>`, and a `modelsRemote` beside `threadsRemote` stages the desktop-exposed methods, `catalog`, `kind` and `kinds`, plus `icons` at 1.3.0 (`inputModalities` is not exposed to the desktop, `packages/bundle/src/contracts/basic/models.ts:223-226`), each `{ tuple: null, local: false, stream: false }`. When absent, nothing changes for the existing tests. A test answers `icons` through `host['models/v1.icons']` (line 466): a handler that returns a promise the test keeps holds the answer until the test resolves it; a handler that throws `{ code: 'unavailable', message: 'Doric backend is unavailable.' }` makes the read fail as a relayed `unavailable` (the harness relays code and message only, lines 472-482); `modelsV1: '1.2.0'` makes the window's stub refuse `icons` as §9 describes.
  - `tests/client/conversation-nodes.test.ts:118`: the agent avatar becomes `{ role: 'agent', name: 'agent', icon: { kind: 'fallback' } } as const`; the serialized and restored marks it is compared with (lines 192-193) then include the icon.
- Stories: `stories/components/organisms/composer-stack.stories.tsx:38` gives its agent avatar `icon: { kind: 'fallback' }`, since `stories` are type-checked with the client (`bundles/desktop/chat/tsconfig.client.json:17-18`, `bundles/desktop/chat/project.json:24-27`).
- Stories: `stories/support/conversation.ts` and `stories/support/chat-host.tsx` call `setModelsApi` with a fake answering a fixture SVG per pair; `stories/components/organisms/conversation/transcript.stories.tsx` shows an agent turn with an icon, one with the bot glyph and one pending; `stories/components/molecules/reader-avatar.stories.tsx` is unchanged.

### Phase 4

- The files listed under [Docs to update](#docs-to-update).

## Test plan

Tests follow `.agents/skills/behavioral-testing/SKILL.md`: each asserts a public answer, a rendered element or the shipped stylesheet's rules, with doubles only at the host boundary.

### `bundle` (phase 1)

- `models/v1` and `models.provider/v1` list `icons`, and it crosses the envelope as data (`values.test.ts`).
- The icon SVG schema refuses a string that does not start with `<svg` and one of 16,385 characters, and accepts one of 16,384. The request schema refuses a model name of 513 characters.

Command: `npx nx test bundle`.

### `llms` (phase 1)

- `openRouterModelIcon`: `anthropic/claude-sonnet-4` → `claude`, `openai/gpt-5` → `openai`, `google/gemini-2.5-pro` → `gemini`, `google/gemma-3-27b-it` → `gemma`, `deepseek/deepseek-chat` → `deepseek`, `qwen/qwen3-coder` → `qwen`, `meta-llama/llama-4-maverick` → `meta`, `mistralai/mistral-large` → `null`, `acme/coder-7b` → `null`.
- `modelNameIcon`: `Llama3.2` → `meta`, `codellama` → `meta`, `qwen2.5-coder` → `qwen`, `deepseek-r1-distill-qwen` → `deepseek`, `gemini-pro` → `gemini`, `gemma3:12b` → `gemma`, `gpt-oss:20b` → `openai`, `claude-3` → `claude`, `openrouter-auto` → `null`, `phi4` → `null`.
- `isModelIconName` is true for each of the eight names and false for `anthropic` and `toString`.

Command: `npx nx test llms`.

### Providers (phase 1)

- `claude`: every model and the provider answer `claude`.
- `codex`: every model and the provider answer `openai`.
- `openai`: with no `endpoint`, a blank one, `https://api.openai.com/v1` and `https://api.openai.com:443/v1`, every model and the provider answer `openai`. With `http://localhost:11434/v1`: `Llama3.2` → `meta`, `qwen2.5-coder` → `qwen`, `deepseek-r1-distill-qwen` → `deepseek`, `gemini-pro` → `gemini`, `gemma3:12b` → `gemma`, `gpt-oss:20b` → `openai`, `claude-3` → `claude`, `phi4` → `null`, and no provider icon. `https://api.openai.com.example.test` and `not a url` are compatible endpoints.
- `openrouter`: the provider answers `openrouter`; `anthropic/claude-sonnet-4` → `claude` and `acme/coder-7b` → `null` (the lab table itself is covered in `llms`).
- Each record still implements exactly the platform spec (the existing `assertBasicShape` check in `tests/support/world.ts`).

Command: `npx nx run-many -t test -p bundle-claude bundle-codex bundle-openai bundle-openrouter`.

### Core (phase 1)

In a new `bundles/foundation/core/tests/model-icons.test.ts`, calling `modelIcons` (§4) directly. `modelIcons` takes `Pick<KindRegistry, 'find'>` and `Pick<ProviderCache, 'configured'>`, the two members it uses, so the fakes are a `find` over a fixed list of `KindEntry` values, each with a fake `ModelsProvider` whose `icons` the case controls (its other methods throw), and a `configured()` answering a fixed list of `ConfiguredProvider` (`bundles/foundation/core/src/host/models/providers.ts:6-11`):

- A provider record whose `icons` rejects, answers fewer models than asked, or names an icon outside the set gives no icon for that request, and the call does not reject.
- With `deadlineMs: 20`, a provider record whose `icons` never settles gives no icon for its request, and the other request of the same call answers its icons.
- A `providerId` request takes the kind and values of the configured provider with that id; an unknown id answers no provider and `null` per model.
- Every name the answers use is a key of `svgs`, and `svgs` has no other key.

In `bundles/foundation/core/tests/models.test.ts`, over the real provider bundles it boots (line 88), through `models/v1.icons`:

- A draft `openrouter` request answers `claude` for `anthropic/claude-sonnet-4` and `openrouter` for `acme/coder-7b` (fallback), `openrouter` as its own icon, and `svgs` holds the SVG of both names.
- A draft `openai` request on a local endpoint answers `null` for `phi4` and no provider icon.
- A `providerId` request resolves a provider of the configuration given to `models.prepare` (as the file's other tests do, line 269); an unknown kind answers no provider and `null` per model.

Command: `npx nx test bundle-core`.

### Host (phase 1)

- `bridge-exposure.test.ts` passes with `icons` in the snapshot.

Command: `npx nx test doric-host`.

### `desktop` (phase 1)

- `svgMask` answers `url("data:image/svg+xml,…")`; the part after the comma decodes back to the input; an input holding `"`, `\`, `#`, `%` and a line break leaves none of them unescaped in the URL.

Command: `npx nx test desktop`.

### Settings (phase 2)

- Domain: `modelIconRequests` lists the providers in order with their models, adds an unlisted execution model to its provider only, leaves out names longer than 512 characters, and caps at 1000 names. `iconLookupFrom` finds by provider id, answers each name's SVG from `svgs`, and answers `undefined` for an unknown id. `modelGroups` with icons puts each model's icon on its choice and on the added row of an unlisted execution model; `searchModelGroups` keeps the icons.
- Adapter (over the fake host): requests reach `models/v1.icons` without `providerId`; the answer comes back with its `svgs` map; an empty list makes no call; an SVG that does not start with `<svg`, a name missing from `svgs`, or a length mismatch fails with "Doric returned an invalid response.".
- Window, dashboard: a provider the host answers an icon for draws a `[data-slot="model-icon"]` whose mask holds a `data:image/svg+xml` URL; one the host answers none for draws `svg.lucide-server`; no row draws an inline brand `<path>`. This replaces the test at `tests/client/dashboard-providers.test.ts:304-331`.
- Window, picker (`tests/client/execution-picker.test.ts`): `ExecutionPicker` is the `layout.footer` region item `settings-execution-picker` (`bundles/desktop/settings/src/client/index.ts:62-66`), which no window test mounts today. The test's probe bundle, defined in the test file as the dashboard test defines its layout probe (`tests/client/dashboard-providers.test.ts:145-230`), plays the layout's footer: it provides no contract, requires `ui/v1@^1.0.0` and `navigation/v1@^1.0.0`, and registers the route `/footer` whose `create` answers `services.use(UiV1).create('settings-execution-picker')`. The test opens `openSettingsWindow({ url: 'doric://app/footer', host, probe })` (`tests/client/support/window.ts:240`). With the popover open, every model row has a `[data-slot="model-icon"]`, empty for a model without an icon, and the effort rows have no `[data-slot="model-icon"]`; the trigger wears the selected model's icon before its name, and none when the host answers none.
- Window, no markup: once the icons are drawn, the dashboard and the open picker hold no element of the fixture SVGs (each fixture carries a unique `id`, and `document.getElementById` finds none).
- `providerSite` answers OpenRouter's site and nothing for other kinds (`tests/provider-icon.test.ts:56-63`, kept).

Commands: `npx nx run bundle-settings:test`, `npx nx run bundle-settings:typecheck`.

### Chat (phase 3)

- Projector (`tests/projector.test.ts`, near the `agent.started` cases at lines 910-923): an agent turn wears the `providerId` and model of the `response.started` before it; after a second `response.started` with another model, the next agent turn wears that model and the first keeps its own; a `response.started` without `providerId` leaves the next turn without one; an answer produced only by `prompt.finished` wears the model.
- Projector in batches (`tests/projector-coalesced.property.test.ts`): the generator's `promptEvents` (lines 46-109) pushes a `response.started` after `agent.started` and after each `tool.finished` or `tool.failed`, with `providerId` drawn from `['or', 'local', '']` and `model` from `['a', 'b']`. The existing comparison of `turns` read in batches with `turns` read at once (lines 217-232) then covers `answeredBy`.
- Sync (`tests/conversation-sync.test.ts`, beside the mark cases at lines 348-423, which keep passing because they compare only `step.mark?.role`): the agent's mark carries the `answeredBy` of the stretch's first answer, also when a later answer of the stretch has another one; an agent turn without `answeredBy` gives a mark without it; a bundle instruction's agent mark (the case at lines 144-196) carries none; no step's `author` carries `answeredBy`.
- Avatar (`tests/client/turn-avatar.test.ts:61-73`, replacing "the agent wears its face, its rim and its glyph"): an agent wears `--turn-avatar-icon` built from the model's SVG and no `--turn-avatar-face`, `--turn-avatar-ring` or `--turn-avatar-mark`; the fallback wears the bot glyph; pending wears a mask that is not the glyph; two agent avatars with different icons are not the same mark.
- Marks (`tests/client/turn-marks.test.ts`, with `openChatWindow({ modelsV1: '1.3.0', … })` and a thread log whose `response.started` records `providerId` and `model` before the text of the run's first answer): while the `models/v1.icons` handler holds its answer, the agent's mark is the empty mask; once the test resolves it with a fixture SVG, the mark wears that SVG without its turn changing; a moved mark stays hidden (lines 196-213 keep passing).
- Styles (`tests/client/conversation-styles.test.ts`): `MARKS` (lines 155-159) becomes the user and agent `::after`; no rule draws the agent's `::before`; the agent's `::after` paints `var(--foreground)` through `mask: var(--turn-avatar-icon) center / 1.125rem no-repeat` inside the unchanged 1.375rem box; the reader's `::after` has `border-radius: 25%` and no mark rule has `9999px`; the moved-mark rule names no `::before` of the agent.
- `ReaderAvatar` (`tests/client/reader-avatar.test.ts`, new) rendered with `react-dom/server`'s `renderToStaticMarkup` has `rounded-[25%]` and not `rounded-full`.
- Icons (`tests/client/model-icons.test.ts`, new): with no handle `readModelIcon` answers `null`; with a fake handle it answers the SVG of the pair, `null` when the answer names none, `null` when the call throws `ContractError('unavailable', …, { contract: 'models/v1', method: 'icons' })`, and rejects when the call throws a `ContractError` with code `unavailable` and no details, or any other error.
- Failure (`tests/client/turn-marks.test.ts`, `modelsV1: '1.3.0'`): with a `models/v1.icons` handler that throws `{ code: 'unavailable', message: 'Doric backend is unavailable.' }`, the agent's mark is the empty mask, not the bot glyph.
- Known absent (`tests/client/turn-marks.test.ts`, `modelsV1: '1.2.0'`): the agent's mark is the bot glyph.
- No markup (`tests/client/turn-marks.test.ts`, `modelsV1: '1.3.0'`): the transcript of an agent turn with an icon holds no element of the fixture SVG (found by its `id`).

Commands: `npx nx run bundle-chat:test`, `npx nx run bundle-chat:typecheck`.

### Checks

After each phase, as `AGENTS.md:95-104` asks: `npx biome format --write <changed files>`, `npm run format:check`, `npm run lint`, then `npx nx run-many -t typecheck test -p bundle llms bundle-claude bundle-codex bundle-openai bundle-openrouter bundle-core doric-host desktop bundle-settings bundle-chat bundle-default bundle-threads bundle-usage`, limited to the projects the phase changed.

## Acceptance criteria

1. The contracts of §1 exist, `models.provider/v1` at 1.2.0 and `models/v1` at 1.3.0; the four providers declare `models.provider/v1@1.2.0` and the core `models/v1@1.3.0`.
2. Each kind answers the names of U6, U10, U12 and U13, in the order of §3.
3. `models/v1.icons` behaves as §4 states.
4. `packages/llms/src/lib/icons/lobehub.ts` holds the eight values whose stored hashes §2 lists, and `packages/llms/PROVENANCE.md` holds the record of §2.
5. The picker matches U2: every model row has a `[data-slot="model-icon"]`, and the effort rows have none.
6. `provider-icon-paths.ts`, `isLocalEndpoint` and `providerMark` no longer exist; the provider pages match U9; `providerSite` is unchanged.
7. The gutter marks match U4, U5, U8 and U11, with the CSS of §10.
8. `ReaderAvatar` matches U5.
9. No fixture SVG appears as an element of the document in the Settings and chat tests of the [Test plan](#test-plan).
10. Every command of the [Test plan](#test-plan) passes, and each file under [Docs to update](#docs-to-update) states what is listed for it.

## Docs to update

The feature doc holds the full description; every other doc keeps a sentence or two and links it, as `docs/designs/coding-workflow-skill.md` does for its features.

### New feature doc

[docs/features/model-icons.md](../features/model-icons.md), in the format of `docs/features/cwd-tool.md:1-30`:

- Header: Status `implemented` once phase 3 lands (`accepted` before); Brief none; Specs this spec; Decisions the record below.
- Problem: [Problem](#problem) in two sentences.
- Decisions: one line each for U1-U13 and D1-D10, linking this spec.
- Current behavior and contracts: the two `icons` methods and their schemas; the table of §3 and the family table of §2 with its two rules; the fallback; the picker (16px), provider page and gutter (18px in the 22px box) drawings; the three agent mark states; the reader's squares; `PROVENANCE.md`.
- Evolution: 2026-10-18, the agent's bot glyph and the renderer's provider marks (commit `96cbe110`); the date this change lands, this spec.

### Existing docs

- `GROUNDING.md`:
  - lines 578-580: the renderer also learns each model's icon from the host (`models/v1.icons`), so it carries no brand list;
  - lines 591-596: the execution model popover draws each model's 16px mono icon before its name, and the trigger the selected model's; the effort rows draw none;
  - lines 1114-1123: the passage's "A turn's mark (the reader's initials, the agent's bot)" becomes "A turn's mark (the reader's initials in a square with 25% corners, or the 18px icon of the model that gave the answer wearing it — its provider's own when the model has none, the bot glyph when neither exists, nothing while it loads)"; the rest of the passage (size, gutter, centering, narrow pane, moving to the comment group) and the paragraph before it on where each mark is worn (lines 1109-1113) are unchanged;
  - lines 1586-1589, in the core's list of `models/v1` additions, after `inputModalities`: `models/v1` 1.3.0 adds `icons` over `models.provider/v1.icons` (1.2.0), linking the feature doc;
  - lines 1825-1834: one sentence that each kind chooses icons by name from the LobeHub set copied into `packages/llms` and recorded in `packages/llms/PROVENANCE.md` (`AGENTS.md:45-48` asks for a GROUNDING.md update when the vendored dependency strategy changes);
  - HC-008 (lines 3225-3231) is unchanged: no generation path exists for the icon module, and `PROVENANCE.md` explains why it changed, which is what the rule asks.
- `docs/architecture/bundles/*.md`: none lists the `models` methods. `contracts.md:394-396` shows only the `ModelsProviderV1` reference, and `core.md:45,72` describes `models/v1` as an aggregation. No change.
- `docs/architecture/bundles/implementation-decisions.md`: a new record in Portuguese, `## Ícones de modelo escolhidos pelo provedor (2026-11-03)`, with D2, D4, D5, D7, D8 and D10 in one line each, the breaking change for out-of-repository providers ([Compatibility](#compatibility)) and a link to the feature doc. Earlier records are not edited.
- `bundles/foundation/core/README.md:55-61`: the `models/v1` item adds "`icons` (1.3.0) answers model and provider icons from the provider records".
- `bundles/providers/{claude,codex,openai,openrouter}/README.md`, "Behavior": one bullet with the kind's row of §3 (for `openai`, the family order).
- `packages/llms/README.md`: one paragraph on the icon set, its names, `modelFamilies` with `openRouterModelIcon` and `modelNameIcon`, and `PROVENANCE.md`.
- `bundles/desktop/settings/README.md:6`: the footer picker draws each model's icon.
- `bundles/desktop/chat/README.md`: one sentence that the agent's gutter mark is the answering model's icon, linking the feature doc.

## Open questions

None. The user answered Q1-Q5 and the question after version 3 (U8-U12), and added U13.

## Revisions

- **Version 6 (2026-11-03), a rebase onto `1f22384d` with no change to U1-U13.** Main gained `91fee634` (#49, `models/v1.inputModalities`) and `d59b16b6` (#50, the agent's mark on a stretch's first answer).
  - Versions: `models/v1` 1.2.0 → 1.3.0 (1.2.0 is `inputModalities`), core 1.12.0 → 1.13.0, Settings requires `models/v1@^1.3.0`; `models.provider/v1` 1.1.0 → 1.2.0, the providers 1.0.0 → 1.1.0, Settings 1.3.0 → 1.4.0 and the chat 1.5.1 → 1.6.0 are unchanged from version 5. The schema comments of §1 name the contract each version belongs to. The chat window tests stage `models/v1` at 1.2.0 (no `icons`) or 1.3.0.
  - §1: the new schemas follow `configurationValuesSchema` and `catalogModelRequestSchema`; `icons` follows `inputModalities` in `Models` and `modelsMethods`.
  - §4: `icons` is wired after `inputModalities` and shares nothing with `capacity.ts`'s `catalogModel`, which resolves providers; `icons` does not.
  - §8 and §10: the icon travels with `AuthorMark`, which `markFor` sets on a stretch's first answer from that turn's `answeredBy`, instead of with `AuthorDraft`, which trails the stretch's last turn and is now unchanged. `$syncAuthor` builds the avatar from `mark`; the `syncedTurns` entry gains `markIcon` beside the existing `markRole`.
  - Tests: the sync cases sit beside #50's mark cases, which keep passing; the three hand-written `models/v1` fakes gain `icons` after their `inputModalities`, the usage fake with its `unexpected` stub.
  - Every line reference was checked against `1f22384d`; those into the files the two commits changed moved (`GROUNDING.md`, `models.ts`, `values.test.ts`, `executor.ts`, `claude.ts`, the core's `index.ts` and `README.md`, the chat's sync, authors and turn-node plugin, the three fakes).

- **Version 5 (2026-11-03), the workflow's fourth review round (Readiness and Codebase reviews).**
  - Major 1: `readModelIcon` answers `null` only for the window stub's own refusal, `unavailable` with `details` `{ contract: 'models/v1', method: 'icons' }`; every other `unavailable` (inactive caller, closed link, no generation, host stopping, anything relayed by the bridge) is a failure and leaves the mark empty. §9 lists those cases; the Test plan covers both outcomes.
  - Major 2: the failure, deadline and configured-provider cases move to a new `bundles/foundation/core/tests/model-icons.test.ts` that calls `modelIcons` with fakes; `modelIcons` takes `Pick<KindRegistry, 'find'>` and `Pick<ProviderCache, 'configured'>`. `models.test.ts` keeps the cases over the real bundles.
  - Major 3: the picker test names its probe: a bundle in the test file that registers `/footer` and mounts `settings-execution-picker`, opened at `doric://app/footer`.
  - Major 4: `openChatWindow` gains `modelsV1` to stage `models/v1` at 1.1.0 or 1.2.0; tests hold or reject `icons` through the `host` handler.
  - Major 5: `conversation-nodes.test.ts:118` and `composer-stack.stories.tsx:38` give their agent avatar `icon: { kind: 'fallback' }`.
  - Nits: schema placement after `configurationValuesSchema`; `OpenRouterLab` imported internally, not exported; the `llms` test list names `modelNameIcon`; `reader-avatar.test.ts` and the no-markup case have files; `gcTime: Infinity` matches D10; the Gutter mark and Provider record terms, the CSP lines, the `useProviderKinds` comparison, the `conversation-authors.ts` description and the narrow-pane lines are corrected.

- **Version 4 (2026-11-03), the workflow's third review round (Scope review of the changes since version 1) and the user's answer.**
  - User answer: U12 records the user's words, "Sim, ícones do Gemma e outros que tivemos suporte também": on a compatible endpoint the name rule covers every model family of the set (Claude, Gemini, Gemma, OpenAI by `gpt`, DeepSeek, Qwen, Meta by `llama`), and OpenRouter, a provider brand, is matched by no name. Open questions and the version 3 entry no longer call the Gemma name rule an inference (Major 1).
  - The chat's read has no deadline and no retry; a failure leaves the mark empty and is fetched again on remount; the timer test is gone (Major 2).
  - `useModelIcons` asks at once on each change; the 500 ms delay is gone (Major 3).
  - `iconsOf` uses the core's `bounded` helper, exported from `bundles/foundation/core/src/shared/hooks.ts` (Nit 4).
  - Settings' call has no deadline (Nit 5).
  - `svgMask` goes in `desktop/ui/utils`, `AGENT_MARK` is built with it, and the separate export and phase are gone; phases renumbered 1-4 (Nit 6).
  - One family table, `modelFamilies` in `llms`, serves `openRouterModelIcon` and the new `modelNameIcon`; D9 says so (Nit 7).
  - `IconAnswer` is removed: Settings keeps `ModelIconAnswers` and reads names through `svgs` (Nit 8).
  - Alternatives gains the rejected version 3 choices.

- **Version 3 (2026-11-03), the workflow's second review round (Comprehension, Critique, Structural and Style reviews) and the user's answers.**
  - User answers: U12 (Gemma icon for `google/gemma…` on OpenRouter; the set grows to eight with `icons/gemma.svg`, 2078 bytes, SHA-256 `8f9b74f6…`). The compatible-endpoint rule also gave a name containing `gemma` the Gemma icon; the user decided it after version 3 (U12). U13 (`gpt` on a compatible endpoint → OpenAI). §3 now states the family order `claude`, `gemini`, `gemma`, `gpt`, `deepseek`, `qwen`, `llama`, why, and that matching is by substring. Q5 removed.
  - Critique: the Compatibility section states the breaking change for out-of-repository providers and why it is accepted (C1); the chat's handle is shown to be set during activation, and `readModelIcon` tells known absence (`unavailable`, no handle, no name) from failure (C2); failures retry three times and leave the mark empty, not the bot glyph (C3); the core gives each provider 1000 ms (D5, §4, R11) (C4); the `svgMask` test no longer requires `)` to be escaped (C5); the coalesced-projector test's generator emits `response.started` (C6). Nits: R2 has an owner and a mitigation; R3 names compatible OpenAI-family names; R4 weighs the revision key; R5 has a 500 ms delay and names the flicker; R6 bounds model names at 512 characters and names the fan-out; R9's alternative (Settings with `models/v1` optional) is weighed; R10 relies on stored hashes now in §2.
  - Comprehension: Terms gains Architecture and Models tables with links (M1); [Approved previews](#approved-previews) records P1-P3, and the `fill-rule` claim cites the npm files (M2); §8 opens with how a prompt becomes turns (M3); Settings' lookup is renamed `IconLookup`, the contract's answer `ModelIconAnswers`, §1 states how the request and answer types relate, "provider values" and "Settings configuration" are separate terms, and "draft" means only the Settings draft (M4); §2 gives the exact replacements, the stored hashes, the check and the upgrade procedure, and the module header no longer says "do not edit" (M5). Nits: HC-004 and HC-008 are quoted where cited; `capacityOf` is explained; forward references link their sections; `'crosses'` is explained; the family rule says substring; `isOpenAiEndpoint` names its key and the `openai` `icons` function is shown; `applyTurnAvatar` says what it clears and what code is deleted; the CSP that allows `data:` masks is cited; effort rows are a term; the review rounds are named; lucide is named at first use.
  - Style: G4 says no list of icons remains (S1); the previews are "previews", P1-P3 (S2); the agent mark, the fallback and the "names over SVG" argument are stated once and referenced, D11-D18 are removed and D-ids renumbered to D1-D10 (S3). Nits: shorter title and status; U8-U12 name the version of their question; U3 points to §7; subjective reasons replaced by checkable ones; filler removed; the runtime-runtime and transport fakes, the marks test file and the check command are decided; acceptance criteria 5 and 9 are measurable and 9 has tests; "bot glyph", "provider's own icon", px units with rem in CSS, `MODEL_ICON_MAX_LENGTH` and American spelling throughout.
  - Structural: the feature-doc link stays, as `docs/designs/coding-workflow-skill.md:6` does, and the header says the docs step creates the file; bold pseudo-headings are `####`/`###` headings; Files to change has a phase 5 group.
- **Version 2 (2026-11-03), the workflow's first review round (Scope review) and the user's answers.**
  - User answers recorded as U8 (18px gutter icon in the unchanged 22px box), U9 (`ServerIcon` for any provider without an icon), U10 (Claude as the `claude` kind's own icon; Anthropic dropped from the set) and U11 (empty mark while loading); U4, U6 and U7 updated to match; Q1-Q4 removed.
  - The OpenRouter rule reads the lab from `openRouterProfileForModel` through `openRouterModelIcon`, instead of a second prefix table.
  - The provider answers icon names from the shared `llms` set; the core resolves names into SVG and answers the renderer with names plus each used SVG once.
  - The generator, the hash record and the provenance test are removed; `PROVENANCE.md` holds the source hashes, the edits and the MIT text.
  - Nits: the Problem says why the reader's square ships here; `providerSite` stays in `domain/provider-icon.ts`; `AGENT_MARK` keeps its name; `isOpenAiEndpoint` compares with `openAiMetadata.baseUrl`; the Settings adapter sends one call; the avatar serialization helpers are removed.
- **Version 1 (2026-11-03).** First draft.
