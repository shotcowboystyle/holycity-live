import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

// dash.js wires the phone bottom sheet on import without checking, so every dashboard needs the pieces it expects
test('every dashboard has the sheet handle, a drawer button and a map', () => {
  for (const page of ['risk.html', 'construction.html', 'safety.html', 'services.html']) {
    const html = read(page), card = html.match(/<section id="card"[\s\S]*?<\/section>/)?.[0] ?? '';
    assert.match(card, /<button class="handle" type="button" aria-expanded="false" aria-label="[^"]+">/, `${page}: handle in the card`);
    assert.match(html, /<div class="corner">[\s\S]*?popovertarget="more"/, `${page}: drawer button in the corner`);
    assert.match(html, /<div id="(map|view)">/, `${page}: map element`);
  }
});

// the shell's phone tab bar reads the long name for frame titles and analytics, and keeps both names on each dashboard tab
test('dashboard tabs carry a long name and a short phone label', () => {
  const tabs = [...read('index.html').matchAll(/<a role="tab" data-tab="(risk|construction|safety|services)"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.equal(tabs.length, 4);
  for (const [, tab, inner] of tabs) {
    assert.match(inner, /<span class="long">[^<]+<\/span>/, `${tab}: long name`);
    assert.match(inner, /<span class="short" aria-hidden="true">[^<]+<\/span>/, `${tab}: short label`);
  }
});
