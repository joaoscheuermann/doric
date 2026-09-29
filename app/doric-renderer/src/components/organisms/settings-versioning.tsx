import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  type Configuration,
  type Credential,
  credentialLabel,
  credentialsOfKind,
  updateCredentialChoice,
} from '@/domain/config';

type SettingsVersioningProps = {
  readonly draft: Configuration;
  readonly onChange: (next: Configuration) => void;
  /** The stored credentials this section chooses between. */
  readonly credentials: readonly Credential[];
};

/** The value a cleared selection carries, because an item cannot hold none. */
const none = '__none__';

/**
 * One integration's credential choice. The combobox offers only the credentials
 * of the kind that integration needs, so the two halves cannot be crossed: a
 * provider key is never offered as a Git identity, and an identity is never
 * offered as a token. Choosing none is a real choice and clears the reference.
 */
function Choice({
  description,
  id,
  kind,
  label,
  onSelect,
  options,
  value,
}: {
  readonly description: string;
  readonly id: string;
  readonly kind: 'GIT' | 'API_TOKEN';
  readonly label: string;
  readonly onSelect: (id: string | undefined) => void;
  readonly options: readonly Credential[];
  readonly value: string | undefined;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value ?? none}
        onValueChange={(next) => onSelect(next === none ? undefined : next)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose a credential" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={none}>None</SelectItem>
            {options.map((credential) => (
              <SelectItem key={credential.id} value={credential.id}>
                {credentialLabel(credential)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription>
        {options.length === 0
          ? `No ${kind === 'GIT' ? 'Git identity' : 'API token'} credential is stored yet; add one under Credentials. ${description}`
          : description}
      </FieldDescription>
    </Field>
  );
}

/**
 * The credentials Git and GitHub use. The Git identity is who commits and holds
 * no secret at all; the GitHub token is what authenticates a push and the
 * sandbox's GitHub CLI. They are separate choices because they are separate
 * concerns: the same person can commit as one identity while pushing with a
 * different account's token.
 *
 * Nothing is inferred here. The host falls back to the only credential of a kind
 * when a choice is unset, but a selection made here is what the configuration
 * records and travels with, so naming one is how an ambiguous store is resolved.
 */
export function SettingsVersioning({
  credentials,
  draft,
  onChange,
}: SettingsVersioningProps) {
  const identities = credentialsOfKind(credentials, 'GIT');
  const tokens = credentialsOfKind(credentials, 'API_TOKEN');

  return (
    <FieldGroup>
      <Choice
        id="git-credential"
        kind="GIT"
        label="Git identity"
        description="The username and email the agent's git commands commit with. It holds no secret."
        options={identities}
        value={draft.gitCredentialId}
        onSelect={(id) =>
          onChange(updateCredentialChoice(draft, 'gitCredentialId', id))
        }
      />
      <Choice
        id="github-credential"
        kind="API_TOKEN"
        label="GitHub token"
        description="Authenticates a push, and the sandbox's GitHub CLI. Without one the sandbox can commit but not push."
        options={tokens}
        value={draft.githubCredentialId}
        onSelect={(id) =>
          onChange(updateCredentialChoice(draft, 'githubCredentialId', id))
        }
      />
    </FieldGroup>
  );
}
