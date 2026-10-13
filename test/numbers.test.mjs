import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalText, readNumericInput } from '../public/numbers.mjs';

test('small intervals and large numbers display without exponential notation', () => {
  for (const [input, expected] of [[1e-7, '0.0000001'], ['1.25e-8', '0.0000000125'], ['1e+21', '1000000000000000000000'], ['1.2e1', '12'], ['1.23e1', '12.3'], [9007199254740991, '9007199254740991'], ['0e999999999', '0']]) {
    assert.equal(decimalText(input), expected);
  }
  assert.equal(decimalText(Number.MIN_VALUE), '0.' + '0'.repeat(323) + '5');
});

test('decimal and pasted exponent inputs retain the configured numeric value', () => {
  for (const text of ['0', '0.0000001', '1e-7', '.25', '3600', '5e-324']) {
    assert.equal(readNumericInput(text, 'interval'), Number(text));
  }
  for (const text of ['6', '100000', '9007199254740991', '1e6', '10.0']) {
    assert.equal(readNumericInput(text, 'count'), Number(text));
  }
});

test('invalid, underflowing and rounded fractional inputs do not silently change the job', () => {
  for (const text of ['', ' ', '0x10', 'Infinity', '-1', '1e', '1,000', 'NaN']) {
    assert.throws(() => readNumericInput(text, 'interval'));
    assert.throws(() => readNumericInput(text, 'count'));
  }
  for (const text of ['3601', '1e-999999999']) assert.throws(() => readNumericInput(text, 'interval'));
  for (const text of ['0', '1e-7', '1e-999999999', '1.00000000000000001', '9007199254740990.1', '9007199254740992']) assert.throws(() => readNumericInput(text, 'count'));
});
