// What a failure stored in a Thread's log reads as. The host stores errors as
// JSON with their causes; the conversation shows the cause that explains the
// failure, not only the outermost wrapper.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { failureText } from '../src/client/domain/errors.js';

describe('the text of a stored failure', () => {
  test('starts at what the tool threw, not the wrapper that names the tool', () => {
    assert.equal(
      failureText({
        name: 'ToolErrorObject',
        message: 'Tool handler failed: papercraft_preview',
        data: { code: 'handler_failed', toolName: 'papercraft_preview' },
        cause: {
          name: 'ContractError',
          code: 'invalid_input',
          message: 'The preview did not compile:\nsrc/a.tsx:1:2: bad import',
        },
      }),
      'The preview did not compile:\nsrc/a.tsx:1:2: bad import',
    );
  });

  test('adds each cause on its own line unless an outer line already quotes it', () => {
    assert.equal(
      failureText({
        message: 'The provider request failed: connect ECONNREFUSED',
        cause: {
          message: 'connect ECONNREFUSED',
          cause: { message: 'socket closed by peer' },
        },
      }),
      'The provider request failed: connect ECONNREFUSED\nCaused by: socket closed by peer',
    );
  });

  test('reads a bare string as itself and nothing stored as no text', () => {
    assert.equal(failureText('redacted'), 'redacted');
    assert.equal(failureText(undefined), '');
    assert.equal(failureText({ code: 'boom' }), '');
  });
});
