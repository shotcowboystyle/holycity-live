import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShef } from './stofs.js';

const sample = `:SHEF ENCODED 30 MINUTE WATER LEVEL MODEL GUIDANCE
.E PSBM1 20261004 Z DH1800/DC10041800/HMIFC/DIN30/     7.59/     9.66
.E1      17.51/    18.59
.E CHTS1 20261004 Z DH1800/DC10041800/HMIFC/DIN30/     6.11/     6.34/     6.40
.E1       5.56/     5.01
.E2       4.39/
.E XXXX1 20261004 Z DH1800/DC10041800/HMIFC/DIN30/     1.00
`;

test('parses one station block and stops at the next station', () => {
  const r = parseShef(sample, 'CHTS1');
  assert.equal(r.start, Date.UTC(2026, 9, 4, 18) / 1000);
  assert.equal(r.intervalMin, 30);
  assert.deepEqual(r.values, [6.11, 6.34, 6.40, 5.56, 5.01, 4.39]);
});

test('station at the very start of the file', () => {
  assert.deepEqual(parseShef('.E CHTS1 20261004 Z DH0000/DIN30/ 1.5/ 2.5\n', 'CHTS1').values, [1.5, 2.5]);
});

test('missing station throws', () => {
  assert.throws(() => parseShef(sample, 'NOPE1'), /not in SHEF/);
});
