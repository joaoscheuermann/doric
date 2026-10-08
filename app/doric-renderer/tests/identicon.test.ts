import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { identiconSvg } from '../src/utility/identicon';

describe('the mark an identity carries', () => {
  test('draws the same name the same way', () => {
    assert.equal(
      identiconSvg('jao.scheuermann'),
      identiconSvg('jao.scheuermann'),
    );
  });

  test('separates two names into two marks', () => {
    assert.notEqual(identiconSvg('agent'), identiconSvg('jao.scheuermann'));
  });

  test('draws an svg for every name, empty ones included', () => {
    assert.match(identiconSvg(''), /^<svg/);
  });
});
