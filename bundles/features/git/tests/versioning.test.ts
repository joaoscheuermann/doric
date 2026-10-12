// The Versioning section's credential choices (stage 10, §3.8): each choice
// offers only the credentials of the kind its integration needs, a choice is
// written into the draft, and "None" removes the reference.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type Credential,
  credentialLabel,
  credentialsFrom,
  credentialsOfKind,
  updateCredentialChoice,
} from '../src/client/domain/credentials.js';

const stored: readonly Credential[] = [
  { id: 'c-1', kind: 'GIT', name: 'Work', username: 'ana', hasSecret: false },
  { id: 'c-2', kind: 'API_TOKEN', name: 'GitHub', hasSecret: true },
  { id: 'c-3', kind: 'USERNAME_PASSWORD', name: 'Registry', hasSecret: true },
];

describe('Versioning credential choices', () => {
  test('a choice is recorded, and choosing none deletes the key', () => {
    const draft = {
      revision: 3,
      gitCredentialId: 'c-1',
      githubCredentialId: 'c-2',
    };

    assert.deepEqual(updateCredentialChoice(draft, 'gitCredentialId', 'c-9'), {
      revision: 3,
      gitCredentialId: 'c-9',
      githubCredentialId: 'c-2',
    });
    for (const none of [undefined, '']) {
      const next = updateCredentialChoice(draft, 'githubCredentialId', none);
      assert.deepEqual(next, { revision: 3, gitCredentialId: 'c-1' });
      assert.equal('githubCredentialId' in next, false);
    }
    // The draft it was given is left as it was.
    assert.equal(draft.githubCredentialId, 'c-2');
  });

  test('each integration is offered only its kind, labelled without secrets', () => {
    assert.deepEqual(credentialsOfKind(stored, 'GIT').map(credentialLabel), [
      'Work (ana)',
    ]);
    assert.deepEqual(
      credentialsOfKind(stored, 'API_TOKEN').map(credentialLabel),
      ['GitHub'],
    );
  });

  test('reads the stored list as the settings window did', () => {
    assert.deepEqual(credentialsFrom(stored), stored);
    assert.throws(() => credentialsFrom({}), {
      message: 'Doric returned an invalid response.',
    });
    assert.throws(() => credentialsFrom([{ id: 'c-1', kind: 'SSH' }]), {
      message: 'Doric returned an invalid response.',
    });
  });
});
