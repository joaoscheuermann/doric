import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  type Configuration,
  storedTokenNotice,
  tokenFieldText,
  updateGitHub,
} from '@/domain/config';

type SettingsCredentialsProps = {
  readonly draft: Configuration;
  readonly onChange: (next: Configuration) => void;
};

/**
 * The credentials the agent may use inside a Project's sandbox. The section is a
 * container of blocks: one per credential kind, each with its own fields and its
 * own rules. GitHub is the one kind today, so a second kind is one more headed
 * block here rather than a section of its own.
 *
 * A token is the only secret this surface touches, and it is write-only: the
 * host answers whether it holds one, never the token, so the field starts empty
 * and an empty field keeps whatever is stored. What the field holds is sent
 * only to the host, which stores it and never sends it back, and the agent's
 * git commands use it inside the sandbox.
 */
export function SettingsCredentials({
  draft,
  onChange,
}: SettingsCredentialsProps) {
  const github = draft.github;

  return (
    <FieldGroup>
      <FieldDescription>
        Secrets the host stores for the agent to use inside a Project's sandbox.
      </FieldDescription>
      <FieldSet>
        <FieldLegend>GitHub</FieldLegend>
        <FieldDescription>
          The GitHub identity the agent's git commands commit and push with.
        </FieldDescription>
        <Field>
          <FieldLabel htmlFor="github-username">Username</FieldLabel>
          <Input
            id="github-username"
            autoComplete="off"
            value={github?.username ?? ''}
            onChange={(event) =>
              onChange(updateGitHub(draft, { username: event.target.value }))
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="github-email">Email</FieldLabel>
          <Input
            id="github-email"
            type="email"
            autoComplete="off"
            value={github?.email ?? ''}
            onChange={(event) =>
              onChange(updateGitHub(draft, { email: event.target.value }))
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="github-token">Token</FieldLabel>
          <Input
            id="github-token"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={tokenFieldText(github)}
            onChange={(event) =>
              onChange(updateGitHub(draft, { token: event.target.value }))
            }
          />
          <FieldDescription>
            {storedTokenNotice(github)} Whatever you type here is sent only to
            the host, which stores it and never sends it back, and the agent's
            git commands use it inside the sandbox.
          </FieldDescription>
        </Field>
      </FieldSet>
    </FieldGroup>
  );
}
