// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const notes = read('docs/review/app-review-notes-en.md');
const desktop = read('docs/review/desktop-demo-runbook.md');
const video = read('docs/review/pairing-video-script.md');
const forbiddenReviewWord = ['V', 'P', 'N'].join('');

assert.doesNotMatch(notes, new RegExp(`\\b${forbiddenReviewWord}\\b`, 'i'));
for (const field of ['REVIEW DESKTOP NAME', 'REVIEW ACCESS URL OR INSTRUCTIONS', 'DATES AND TIME ZONE', 'CONFIRMED CONTACT']) {
  assert.match(notes, new RegExp(field));
}
assert.match(notes, /Camera access scans the pairing QR code/);
assert.match(notes, /Face ID protects sensitive terminal actions/);
assert.match(desktop, /cialai-review-demo/);
assert.match(desktop, /dedicated operating system account with no personal data/i);
assert.match(desktop, /revoke all review phones/i);
assert.match(video, /no more than 90 seconds/i);
assert.match(video, /Device revoked after capture/);
assert.match(video, /Inspect every frame for personal data/i);

console.log('PASS review pack: App Review copy, isolated desktop demo and 90 second pairing video script');
