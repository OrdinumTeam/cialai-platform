// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const fixture = spawn(process.execPath, ['scripts/phone-terminal-fixture.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] });

try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture startup timeout')), 10000);
    fixture.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited ${code}`));
    });
    fixture.stdout.on('data', (data) => {
      const match = String(data).match(/http:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  const select = `document.querySelector('.terminais-card').click()`;
  const files = `document.querySelector('[aria-label="Arquivos da sessão"]').click()`;
  const preview = `Array.from(document.querySelectorAll('.phone-files__entry')).find((entry)=>entry.textContent==='README.md').click()`;
  const report = `document.title=JSON.stringify({pane:document.querySelector('.phone-terminal').className,width:innerWidth,scroll:document.documentElement.scrollWidth,hosts:document.querySelectorAll('.phone-terminal__host').length,cols:window.__phoneFixture.getState().selected?.term.cols,pre:document.querySelector('pre')?.scrollWidth,client:document.querySelector('pre')?.clientWidth,accent:getComputedStyle(document.documentElement).getPropertyValue('--mac-accent').trim()})`;
  for (const [name, width, height, actions, pane] of [
    ['list', 393, 852, [], 'list'],
    ['terminal', 393, 852, [select], 'terminal'],
    ['files', 393, 852, [select, files], 'files'],
    ['preview-landscape', 852, 393, [select, files, preview], 'preview'],
    ['back', 393, 852, [select, files, preview, `document.querySelector('[aria-label="Voltar para arquivos"]').click()`, `document.querySelector('[aria-label="Voltar para terminal"]').click()`, `document.querySelector('[aria-label="Voltar para sessões"]').click()`], 'list'],
  ]) {
    const code = actions.map((action, index) => `setTimeout(()=>{${action}},${250 + index * 250});`).join('')
      + `setTimeout(()=>{${report}},${500 + actions.length * 250})`;
    const { stdout } = await exec('../../../ordinum-control/macos/tools/wksnap', [url, `/tmp/cialai-phone-${name}.png`, String(width), String(height), '--dark', '--wait', '3', '--js', code], { timeout: 15000 });
    const diagnostic = JSON.parse(stdout.split('\n').find((line) => line.startsWith('diag ')).slice(5));
    assert.deepEqual(diagnostic.errs, [], `${name} JavaScript errors`);
    const state = JSON.parse(diagnostic.title);
    assert.ok(state.pane.endsWith(`--${pane}`), `${name} wrong pane`);
    assert.equal(state.width, state.scroll, `${name} document overflow`);
    assert.equal(state.hosts, pane === 'terminal' ? 1 : 0, `${name} must mount one pane only`);
    assert.equal(state.accent.toLowerCase(), '#ff7ab2', `${name} must use the Cialai pink accent`);
    if (pane === 'terminal') assert.ok(state.cols >= 2 && state.cols < 80, 'phone terminal must fit fewer columns than desktop');
    if (pane === 'preview') assert.equal(state.pre, state.client, 'file text must wrap without horizontal overflow');
    console.log('PASS', name, JSON.stringify(state));
  }
} finally {
  fixture.kill('SIGTERM');
}
