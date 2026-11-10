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

// Run the emitted script against stub browser globals; returns the window and how many gtag scripts it injected.
async function run(store = {}) {
  const { runInNewContext } = await import('node:vm');
  const injected = [];
  const localStorage = {
    getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
  };
  const window = { localStorage, document: { createElement: () => ({}), head: { append: s => injected.push(s) } } };
  window.window = window;
  runInNewContext(await gaScript('G-ABC123').text(), window);
  return { window, injected, store };
}

test('consent: nothing loads before a choice', async () => {
  const { window, injected } = await run();
  assert.equal(window.analyticsConsent(), null);
  assert.equal(injected.length, 0);
});

test('consent: accepted under current version loads once', async () => {
  const { window, injected } = await run({ consent: JSON.stringify({ analytics: 'on', v: 1, at: 'x' }) });
  assert.equal(window.analyticsConsent(), 'on');
  window.loadGA(); window.loadGA();
  assert.equal(injected.length, 1);
});

test('consent: older version or garbage asks again', async () => {
  for (const consent of [JSON.stringify({ analytics: 'on', v: 0 }), '{bad', JSON.stringify({ analytics: 'maybe', v: 1 })]) {
    const { window, injected } = await run({ consent });
    assert.equal(window.analyticsConsent(), null, consent);
    assert.equal(injected.length, 0);
  }
});

test('consent: legacy Settings opt-out counts as declined', async () => {
  const { window, injected } = await run({ analytics: 'off' });
  assert.equal(window.analyticsConsent(), 'off');
  assert.equal(injected.length, 0);
});

test('consent: setAnalyticsConsent records the choice and loads on accept', async () => {
  const { window, injected, store } = await run({ analytics: 'off' });
  window.setAnalyticsConsent('off');
  assert.equal(injected.length, 0);
  window.setAnalyticsConsent('on');
  const c = JSON.parse(store.consent);
  assert.equal(c.analytics, 'on'); assert.equal(c.v, 1); assert.ok(!isNaN(Date.parse(c.at)));
  assert.equal(store.analytics, undefined);
  assert.equal(injected.length, 1);
  assert.equal(window.analyticsConsent(), 'on');
});
