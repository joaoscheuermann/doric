// The settings adapter without its bridge. Its view of the workspace window
// (the selected Thread and a Thread's execution) left with the execution
// picker, which the chat draws from bundle isolation 6(c).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { api, initSettingsApi } from '../src/client/api/settings-api.js';

// T-22 (error-messages.md §6.4): with the settings bridge unset, `api()`
// throws at once — not a rejection — a `SettingsApiError` with code
// `internal` that says a repeat fails the same way (`retryable: false`), so
// no notice offers Retry for it.
describe('T-22 the unset settings bridge', () => {
  test('api() throws synchronously SettingsApiError internal, not retryable, with no cause', () => {
    initSettingsApi(undefined);
    let thrown: unknown;
    try {
      api();
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, 'api() returned instead of throwing');
    const error = thrown as Error & {
      readonly code?: unknown;
      readonly retryable?: unknown;
    };
    assert.equal(error.name, 'SettingsApiError');
    assert.equal(error.code, 'internal');
    assert.equal(error.retryable, false);
    assert.equal(error.message, 'Doric backend is unavailable.');
    assert.equal(error.cause, undefined);
  });
});
