// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = `${root}/apps/desktop`;
const resource = `${desktop}/src-tauri/resources/mobile`;
const config = JSON.parse(readFileSync(`${desktop}/src-tauri/tauri.conf.json`, 'utf8'));

assert.equal(config.bundle.resources['resources/mobile/'], 'mobile/');
assert.ok(existsSync(`${resource}/mobile.html`), 'mobile resource entry was not generated');
assert.ok(!existsSync(`${resource}/index.html`), 'desktop entry leaked into mobile resources');

const html = readFileSync(`${resource}/mobile.html`, 'utf8');
const references = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1]);
assert.ok(references.length >= 2, 'mobile resource must reference script and stylesheet assets');
for (const path of references) {
  assert.ok(!path.includes('..') && existsSync(`${resource}/${path}`), `missing mobile resource: ${path}`);
}

const assets = readdirSync(`${resource}/assets`, { withFileTypes: true });
assert.ok(assets.some((entry) => entry.isFile() && entry.name.endsWith('.js')));
assert.ok(assets.some((entry) => entry.isFile() && entry.name.endsWith('.css')));
console.log(`PASS mobile resource: isolated entry with ${assets.length} generated assets and Tauri mapping`);
