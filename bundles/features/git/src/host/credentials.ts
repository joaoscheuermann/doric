import type { CredentialKindDefinition } from 'bundle/contracts';

/**
 * The `GIT` credential kind: the identity a commit is made with. It carries a
 * username and an email and never a secret, so the rule is the kind's own. The
 * git bundle registers it with `secrets/v1`, and the stored rows keep their id.
 */
export const gitCredentialKind: CredentialKindDefinition = {
  id: 'GIT',
  required: ['username', 'email'],
  optional: [],
  label: 'Git identity',
};
