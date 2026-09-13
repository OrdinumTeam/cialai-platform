// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const readme = read('README.md');
const contributing = read('CONTRIBUTING.md');
const security = read('SECURITY.md');
const conduct = read('CODE_OF_CONDUCT.md');

assert.match(readme, /^# Cialai$/m);
assert.match(readme, /open source terminal studio/i);
assert.match(readme, /Prepared code is not the same as verified distribution/);
assert.doesNotMatch(readme, /Cialai é|Fase 0 aberta/);

for (const image of [
  'docs/evidence/task-1.11/cialai-desktop-dark.png',
  'docs/evidence/task-1.11/cialai-mobile-list.png',
  'docs/evidence/task-1.11/cialai-mobile-files.png',
]) {
  assert.match(readme, new RegExp(image.replaceAll('.', '\\.')));
  assert.ok(statSync(`${root}${image}`).size > 10_000, `${image} must be a real screenshot`);
}

assert.match(contributing, /npm run test:integration:headscale/);
assert.match(contributing, /Prepared code|implemented code/i);
assert.match(security, /TO BE CONFIRMED BEFORE PUBLICATION/g);
assert.match(security, /private vulnerability reporting/i);
assert.match(conduct, /Contributor Covenant version 2\.1/);
assert.match(conduct, /TO BE CONFIRMED BEFORE PUBLICATION/);

for (const template of [
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/feature_request.md',
  '.github/ISSUE_TEMPLATE/question.md',
  '.github/pull_request_template.md',
]) {
  const source = read(template);
  assert.ok(source.length > 300, `${template} is unexpectedly short`);
  assert.match(source, /credential|credentials/i);
}

console.log('PASS public docs: English README, inspected captures, contribution and security policies, reviewed templates');
