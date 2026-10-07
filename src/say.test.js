import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeWords, fifth, daysUntil, dayWord, titleCase } from '../public/say.js';

test('changeWords: direction, rounding, flat band, no baseline', () => {
  assert.equal(changeWords(88, 100), 'down 12%');
  assert.equal(changeWords(108, 100), 'up 8%');
  assert.equal(changeWords(102, 100), 'about the same');
  assert.equal(changeWords(5, 0), null);
});

test('fifth: position among other values', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(fifth(0.5, v), 0);
  assert.equal(fifth(5.5, v), 2);
  assert.equal(fifth(99, v), 4);
  assert.equal(fifth(3, []), 2);
});

test('titleCase: City street names', () => {
  assert.equal(titleCase(' 176 CONCORD ST'), '176 Concord St');
  assert.equal(titleCase('STATE ST & CUMBERLAND ST'), 'State St & Cumberland St');
  assert.equal(titleCase(null), '');
});

test('daysUntil / dayWord: next pickup day', () => {
  const wed = new Date(2026, 9, 7); // Wed Oct 7 2026
  assert.equal(daysUntil('WEDNESDAY', wed), 0);
  assert.equal(daysUntil(' thursday ', wed), 1);
  assert.equal(daysUntil('MONDAY', wed), 5);
  assert.equal(daysUntil('Null', wed), null);
  assert.equal(dayWord(0, wed), 'today');
  assert.equal(dayWord(1, wed), 'tomorrow');
  assert.equal(dayWord(5, new Date(2026, 9, 12)), 'Monday');
});
