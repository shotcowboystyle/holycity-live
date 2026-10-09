import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gaScript } from './ga.js';

test('gaScript: empty without a valid measurement ID', async () => {
  for (const id of [undefined, '', 'UA-123', "G-1'); alert(1); ('"]) assert.equal(await gaScript(id).text(), '');
});

test('gaScript: inlines a valid ID', async () => {
  const res = gaScript('G-ABC123');
  assert.equal(res.headers.get('Content-Type'), 'text/javascript');
  const js = await res.text();
  assert.match(js, /gtag\('config', 'G-ABC123'/);
  assert.match(js, /gtag\/js\?id=G-ABC123/);
});
