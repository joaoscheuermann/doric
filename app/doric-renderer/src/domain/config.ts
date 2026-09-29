/**
 * The configuration the host owns: the providers Doric may call, the model
 * execution uses, how many turns one prompt may take, and which stored
 * credentials the Git identity and GitHub authentication use. The host
 * re-validates every rule below and answers `422`, so this module's job is to say
 * why a draft cannot be sent before a request leaves the renderer.
 *
 * No secret is part of this configuration. A provider and the two integrations
 * name a credential by id, and a credential's own secret lives in the credential
 * store, which this module only describes: `C` is the public shape a view reads,
 * and `hasSecret` is what stands in for the value.
 */

export const reasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];

export type ProviderConfiguration = {
  readonly id: string;
  readonly baseUrl: string;
  /** The `API_TOKEN` credential this provider authenticates with. */
  readonly credentialId: string;
};

/** The closed set of credential kinds. A kind fixes which fields it carries. */
export const credentialKinds = [
  'API_TOKEN',
  'USERNAME_PASSWORD',
  'GIT',
] as const;

export type CredentialKind = (typeof credentialKinds)[number];

/**
 * A stored credential as the host answers it. The secret never arrives, so this
 * is the whole shape a view can read: `hasSecret` says whether one is stored,
 * and nothing here can hold the value itself.
 */
export type Credential = {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly hasSecret: boolean;
};

/**
 * The fields a create names. A kind's required fields are the form's business,
 * and the host refuses a create that does not satisfy them.
 */
export type CredentialCreate = {
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly secret?: string;
};

/**
 * The fields a patch may name, as the host reads them. Every one follows the same
 * rule on the wire — absent or `null` keeps what is stored, `''` clears it, and a
 * value sets it — so a secret is never cleared by a caller that did not mean to.
 *
 * A `''` that clears a field is the host's rule, not this surface's: a field the
 * kind forbids is omitted rather than cleared (see `credentialUpdate`), so this
 * module never builds the empty-string form.
 */
export type CredentialUpdate = {
  readonly kind?: CredentialKind;
  readonly name?: string;
  readonly username?: string | null;
  readonly email?: string | null;
  readonly secret?: string | null;
};

export type Configuration = {
  readonly providers: readonly ProviderConfiguration[];
  readonly models: {
    readonly execution: ModelExecution;
  };
  readonly execution: { readonly maxTurns: number };
  /** The `GIT` credential the agent's git commands commit as; absent for none. */
  readonly gitCredentialId?: string;
  /** The `API_TOKEN` credential GitHub authenticates with; absent for none. */
  readonly githubCredentialId?: string;
};

/**
 * The configuration as a save sends it. The body is a plain replacement, so it
 * is exactly the shape the host answers with: no field is write-only any more,
 * because no secret travels with the configuration.
 */
export type ConfigurationInput = Configuration;

export type ModelExecution = {
  readonly providerId: string;
  readonly model: string;
  readonly effort: ReasoningEffort;
};

export type DoricConfiguration = {
  readonly configuration: Configuration;
  readonly revision: number;
  readonly updatedAt: string;
};

/** The bounds the host enforces on a provider id and on a model name. */
const providerIdLimit = 128;
const modelLimit = 512;

/** The bounds the host enforces on a credential's own fields. */
const credentialNameLimit = 128;
const usernameLimit = 128;
const emailLimit = 254;
const secretLimit = 512;

/**
 * A secret carries no whitespace or control character, which is what lets a
 * field refuse a pasted line break instead of trimming a credential.
 */
const secretPattern = /^[\x21-\x7e]+$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * What a provider row is called: its id once the user has given it one, and its
 * place in the list while it is still unnamed.
 */
export const providerLabel = (
  provider: ProviderConfiguration,
  index: number,
): string =>
  provider.id.trim() === '' ? `Provider ${index + 1}` : provider.id;

/**
 * One provider as the providers table draws it: the provider itself, and the
 * position it holds in `Configuration.providers`.
 *
 * The position is the row's identity, and a provider id is not one: a row that
 * was just added has none, and a row being typed may carry a duplicate, so an
 * id would address two rows at once. The table's order is not an identity
 * either, because sorting, filtering and paging each change the order rows are
 * drawn in without changing the list. Carrying the position on the row is what
 * lets a cell keep addressing the provider the user is looking at.
 */
export type ProviderRow = {
  readonly index: number;
  readonly provider: ProviderConfiguration;
};

/** The configured providers as table rows, each keeping its place in the list. */
export const providerRows = (
  configuration: Configuration,
): readonly ProviderRow[] =>
  configuration.providers.map((provider, index) => ({ index, provider }));

/** The name a reasoning effort is shown under. */
export const effortLabel = (effort: ReasoningEffort): string =>
  effort.charAt(0).toUpperCase() + effort.slice(1);

/** The name a credential kind is shown under, in the kind picker and the list. */
export const credentialKindLabel = (kind: CredentialKind): string =>
  kind === 'API_TOKEN'
    ? 'API token'
    : kind === 'USERNAME_PASSWORD'
      ? 'Username and password'
      : 'Git identity';

/** What a credential kind is for, said in one sentence beside its picker. */
export const credentialKindDescription = (kind: CredentialKind): string =>
  kind === 'API_TOKEN'
    ? 'One secret, such as a provider key or a GitHub token.'
    : kind === 'USERNAME_PASSWORD'
      ? 'A username and a secret, such as a registry login.'
      : 'Who commits: a username and an email. It holds no secret.';

/**
 * The fields a kind requires, and the fields it forbids. This mirrors the host's
 * one rule so the form asks for exactly what the host would accept, and a create
 * is refused here rather than after a request.
 */
export const credentialFields = (kind: CredentialKind): readonly string[] =>
  kind === 'API_TOKEN'
    ? ['secret']
    : kind === 'USERNAME_PASSWORD'
      ? ['username', 'secret']
      : ['username', 'email'];

/** The fields a kind carries at all; a field outside this set must stay empty. */
export const credentialAllowedFields = (
  kind: CredentialKind,
): readonly string[] => credentialFields(kind);

/** The turn limit a text field names, or `NaN` while it names none. */
export const turnsFromInput = (value: string): number => {
  const trimmed = value.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
};

/** The host's `updatedAt` as a reader sees it, or verbatim when unreadable. */
export const updatedAtLabel = (updatedAt: string): string => {
  const at = new Date(updatedAt);
  return Number.isNaN(at.getTime()) ? updatedAt : at.toLocaleString();
};

/**
 * The first reason the host would refuse this configuration, in the voice the
 * rest of the surface uses, or `undefined` when it would accept it. The rules
 * are the host's, in the order a person would fix them: a usable provider list
 * first, then the model that runs against it, then the turn limit.
 *
 * The credential choices are not checked here. A choice is an id the credential
 * list offered, and a credential that is deleted is the host's refusal to
 * answer, not a draft this module can judge without the list in hand.
 */
export const configurationIssue = (
  configuration: Configuration,
): string | undefined => {
  const { providers } = configuration;
  if (providers.length === 0) return 'Add at least one provider.';

  const ids = new Set<string>();
  for (const provider of providers) {
    if (
      provider.id.trim() === '' ||
      Array.from(provider.id).length > providerIdLimit
    ) {
      return `Enter an id between 1 and ${providerIdLimit} characters for every provider.`;
    }
    if (ids.has(provider.id)) return 'Provider ids must be unique.';
    ids.add(provider.id);

    if (!isHttpUrl(provider.baseUrl)) {
      return `Enter an http:// or https:// base URL for ${provider.id}.`;
    }
    if (provider.credentialId.trim() === '') {
      return `Choose the credential ${provider.id} authenticates with.`;
    }
  }

  const { effort, model, providerId } = configuration.models.execution;
  if (!ids.has(providerId)) return 'Choose the provider that runs prompts.';
  if (model.trim() === '' || Array.from(model).length > modelLimit) {
    return `Enter a model between 1 and ${modelLimit} characters.`;
  }
  if (!reasoningEfforts.includes(effort)) return 'Choose a reasoning effort.';
  if (
    !Number.isInteger(configuration.execution.maxTurns) ||
    configuration.execution.maxTurns < 1
  ) {
    return 'Enter a turn limit of 1 or more.';
  }
  return undefined;
};

const isSameProvider = (
  left: ProviderConfiguration,
  right: ProviderConfiguration,
): boolean =>
  left.id === right.id &&
  left.baseUrl === right.baseUrl &&
  left.credentialId === right.credentialId;

/**
 * The configuration with one provider replaced wholesale at a position, keeping
 * the list's length. The position is the identity `updateProvider` addresses, and
 * it is the one a dialog's draft carries, so a rename cannot land on the wrong
 * row while the table draws the list in another order.
 */
export const replaceProvider = (
  configuration: Configuration,
  index: number,
  provider: ProviderConfiguration,
): Configuration => {
  const current = configuration.providers[index];
  return current === undefined
    ? configuration
    : updateProvider(configuration, index, {
        baseUrl: provider.baseUrl,
        credentialId: provider.credentialId,
        id: provider.id,
      });
};

/**
 * One provider while it is being edited in a dialog: the fields themselves, and
 * the position it holds in `Configuration.providers`, or `undefined` while it is
 * being added.
 *
 * The draft is separate from the configuration because a dialog edits a copy: the
 * stored list keeps the provider every other screen is reading until the draft is
 * saved, and a half-typed id never becomes the reference the execution settings
 * point at.
 */
export type ProviderDraft = ProviderConfiguration & {
  readonly index?: number;
};

/** A draft for a provider that does not exist yet. */
export const emptyProviderDraft = (): ProviderDraft => ({
  id: '',
  baseUrl: '',
  credentialId: '',
});

/** The provider at one position as an editable draft, or `undefined` if none. */
export const providerDraftOf = (
  configuration: Configuration,
  index: number,
): ProviderDraft | undefined => {
  const provider = configuration.providers[index];
  return provider === undefined ? undefined : { ...provider, index };
};

/**
 * The first reason a provider draft cannot be stored, in the voice the surface
 * uses, or `undefined` when it can. It states the provider's own rules — the same
 * ones `configurationIssue` applies to every provider — so a dialog refuses a row
 * on its own terms instead of reporting the whole list: an empty or duplicated id
 * is still the configuration's to report, because a draft cannot see its
 * neighbours.
 */
export const providerIssue = (draft: ProviderDraft): string | undefined => {
  if (draft.id.trim() === '' || Array.from(draft.id).length > providerIdLimit) {
    return `Enter an id between 1 and ${providerIdLimit} characters for every provider.`;
  }
  if (!isHttpUrl(draft.baseUrl)) {
    return `Enter an http:// or https:// base URL for ${draft.id}.`;
  }
  if (draft.credentialId.trim() === '') {
    return `Choose the credential ${draft.id} authenticates with.`;
  }
  return undefined;
};

/**
 * Whether two configurations describe the same host state. The host owns the
 * configuration, so a change is sent only when the draft differs from the copy
 * the host returned.
 */
export const isSameConfiguration = (
  left: Configuration,
  right: Configuration,
): boolean =>
  left.providers.length === right.providers.length &&
  left.providers.every((provider, index) =>
    isSameProvider(provider, right.providers[index]),
  ) &&
  left.models.execution.providerId === right.models.execution.providerId &&
  left.models.execution.model === right.models.execution.model &&
  left.models.execution.effort === right.models.execution.effort &&
  left.execution.maxTurns === right.execution.maxTurns &&
  left.gitCredentialId === right.gitCredentialId &&
  left.githubCredentialId === right.githubCredentialId;

/**
 * The configuration as a save sends it. The body is a plain replacement, so the
 * draft is already the shape the host accepts and no rewriting happens here.
 */
export const configurationInput = (
  configuration: Configuration,
): ConfigurationInput => configuration;

/**
 * The credentials a selection may offer for one integration. A provider and
 * GitHub authentication both need a secret, so both offer `API_TOKEN` alone;
 * the Git identity is the one that offers `GIT`.
 */
export const credentialsOfKind = (
  credentials: readonly Credential[],
  kind: CredentialKind,
): readonly Credential[] =>
  credentials.filter((credential) => credential.kind === kind);

/**
 * What a selection shows for one credential: its name, with what it carries, so
 * two credentials of a kind are told apart without revealing either secret.
 */
export const credentialLabel = (credential: Credential): string =>
  credential.username === undefined
    ? credential.name
    : `${credential.name} (${credential.username})`;

/**
 * Whether a stored credential is still usable for a kind. A choice survives only
 * while the store still holds that credential and it still has the kind the
 * integration needs, because a kind is immutable but a credential can be
 * deleted.
 */
export const isUsableChoice = (
  credentials: readonly Credential[],
  id: string | undefined,
  kind: CredentialKind,
): boolean =>
  id !== undefined &&
  credentials.some(
    (credential) => credential.id === id && credential.kind === kind,
  );

/**
 * The first reason the host would refuse a credential draft, or `undefined`.
 * The rule is the host's own: every field the kind requires is present, and a
 * field the kind forbids is empty, so a form cannot offer a shape that would be
 * rejected after a round trip.
 */
export const credentialIssue = (draft: CredentialDraft): string | undefined => {
  const name = draft.name.trim();
  if (name === '' || Array.from(name).length > credentialNameLimit) {
    return `Enter a name between 1 and ${credentialNameLimit} characters.`;
  }

  const { kind } = draft;
  const carries = (field: string): boolean =>
    draft[field as keyof CredentialDraft] !== undefined &&
    String(draft[field as keyof CredentialDraft]).trim() !== '';

  if (
    carries('username') &&
    !credentialAllowedFields(kind).includes('username')
  )
    return `A ${credentialKindLabel(kind)} credential carries no username.`;
  if (carries('email') && !credentialAllowedFields(kind).includes('email'))
    return `A ${credentialKindLabel(kind)} credential carries no email.`;
  if (carries('secret') && !credentialAllowedFields(kind).includes('secret'))
    return `A ${credentialKindLabel(kind)} credential carries no secret.`;

  if (carries('username')) {
    const username = draft.username?.trim() ?? '';
    if (Array.from(username).length > usernameLimit) {
      return `Enter a username of at most ${usernameLimit} characters.`;
    }
  }

  if (carries('email')) {
    const email = draft.email?.trim() ?? '';
    if (Array.from(email).length > emailLimit || !emailPattern.test(email)) {
      return 'Enter an email address.';
    }
  }

  if (carries('secret')) {
    const secret = draft.secret ?? '';
    if (
      Array.from(secret).length > secretLimit ||
      !secretPattern.test(secret)
    ) {
      return 'Enter a secret with no spaces or line breaks.';
    }
  }

  const missing = credentialFields(kind).filter((field) => !carries(field));
  if (missing.length > 0) {
    return `A ${credentialKindLabel(kind)} credential needs ${missing.join(' and ')}.`;
  }

  return undefined;
};

/**
 * A credential being typed into the form. `secret` is write-only: an edit starts
 * with it empty and an empty field keeps the stored secret, which is what lets a
 * secret be changed without ever reading it back.
 */
export type CredentialDraft = {
  /** Present when the draft edits a stored credential. */
  readonly id?: string;
  readonly name: string;
  readonly kind: CredentialKind;
  readonly username?: string;
  readonly email?: string;
  readonly secret?: string;
};

/** A blank draft for one kind, so the form asks for exactly that kind's fields. */
export const emptyCredentialDraft = (
  kind: CredentialKind,
): CredentialDraft => ({ kind, name: '' });

/**
 * The create a draft names. Every field the kind does not carry is withheld
 * rather than sent empty, because the host reads a field outside the kind's set
 * as a shape it must refuse.
 */
export const credentialCreate = (draft: CredentialDraft): CredentialCreate => {
  const allowed = credentialAllowedFields(draft.kind);
  return {
    kind: draft.kind,
    name: draft.name.trim(),
    ...(allowed.includes('username') && draft.username !== undefined
      ? { username: draft.username.trim() }
      : {}),
    ...(allowed.includes('email') && draft.email !== undefined
      ? { email: draft.email.trim() }
      : {}),
    ...(allowed.includes('secret') && draft.secret !== undefined
      ? { secret: draft.secret }
      : {}),
  };
};

/**
 * The patch a draft names for an existing credential. An empty secret field is
 * `null`, which keeps the stored secret; a typed one is sent as itself.
 *
 * A field the kind does not carry is **omitted**, not sent as `''`. The host reads
 * `''` as "clear this field", and a cleared field is still a field the credential
 * carries, so a kind that forbids it refuses the patch: `API_TOKEN` with an empty
 * `username` is exactly the shape the host answers with "carries no other field".
 * A kind is immutable, so no patch can ever need to move a value between fields
 * the kinds allow and forbid — the field set only ever stays what the stored row
 * already has.
 */
export const credentialUpdate = (
  draft: CredentialDraft,
  stored: Credential,
): CredentialUpdate => {
  const allowed = credentialAllowedFields(draft.kind);
  const secret = draft.secret ?? '';
  return {
    name: draft.name.trim(),
    ...(allowed.includes('username')
      ? { username: draft.username?.trim() ?? null }
      : {}),
    ...(allowed.includes('email')
      ? { email: draft.email?.trim() ?? null }
      : {}),
    ...(allowed.includes('secret')
      ? { secret: secret === '' ? null : secret }
      : {}),
    ...(draft.kind === stored.kind ? {} : { kind: draft.kind }),
  };
};

/** A stored credential as the draft that edits it. The secret is never read. */
export const credentialDraftOf = (credential: Credential): CredentialDraft => ({
  id: credential.id,
  kind: credential.kind,
  name: credential.name,
  ...(credential.username === undefined
    ? {}
    : { username: credential.username }),
  ...(credential.email === undefined ? {} : { email: credential.email }),
});

/** The configuration with the execution model pointed at one provider. */
const withExecutionProvider = (
  configuration: Configuration,
  providerId: string,
): Configuration => ({
  ...configuration,
  models: {
    execution: { ...configuration.models.execution, providerId },
  },
});

/**
 * Appends a provider to the list. It is written whole rather than patched in
 * afterwards, because the row a dialog adds is the row it filled in.
 */
export const addProvider = (
  configuration: Configuration,
  provider: ProviderConfiguration,
): Configuration => ({
  ...configuration,
  providers: [...configuration.providers, provider],
});

/**
 * Patches one row by position. Renaming the row the execution model references
 * moves the reference with it, so a rename cannot leave it dangling.
 */
export const updateProvider = (
  configuration: Configuration,
  index: number,
  patch: Partial<ProviderConfiguration>,
): Configuration => {
  const provider = configuration.providers[index];
  if (provider === undefined) return configuration;

  const providers = configuration.providers.map((current, currentIndex) =>
    currentIndex === index ? { ...current, ...patch } : current,
  );
  const next = { ...configuration, providers };
  const renamed = patch.id !== undefined && patch.id !== provider.id;
  return renamed && configuration.models.execution.providerId === provider.id
    ? withExecutionProvider(next, patch.id)
    : next;
};

/**
 * Drops the row at a position, the same identity `updateProvider` addresses.
 * A row is not addressable by id yet: an added row has none, and a row being
 * typed may carry a duplicate, so an id would remove two rows at once. The
 * execution model must keep naming a configured provider, so when the removed
 * row was the referenced one the reference moves to the first row left, or to
 * none when the list empties.
 */
export const removeProvider = (
  configuration: Configuration,
  index: number,
): Configuration => {
  const removed = configuration.providers[index];
  if (removed === undefined) return configuration;

  const providers = configuration.providers.filter(
    (_, current) => current !== index,
  );
  const next = { ...configuration, providers };
  return configuration.models.execution.providerId === removed.id
    ? withExecutionProvider(next, providers[0]?.id ?? '')
    : next;
};

/** Patches the model execution runs. */
export const updateModel = (
  configuration: Configuration,
  patch: Partial<ModelExecution>,
): Configuration => ({
  ...configuration,
  models: { execution: { ...configuration.models.execution, ...patch } },
});

/** Sets how many turns one prompt may take. */
export const updateTurnLimit = (
  configuration: Configuration,
  maxTurns: number,
): Configuration => ({
  ...configuration,
  execution: { ...configuration.execution, maxTurns },
});

/**
 * Sets the credential an integration uses, or clears the choice. A cleared
 * choice travels as an absent id rather than an empty string, because the host
 * reads "no id" as unconfigured and an empty id as a reference that cannot
 * resolve.
 */
export const updateCredentialChoice = (
  configuration: Configuration,
  field: 'gitCredentialId' | 'githubCredentialId',
  id: string | undefined,
): Configuration => {
  const next = { ...configuration };
  if (id === undefined || id === '') delete next[field];
  else next[field] = id;
  return next;
};
