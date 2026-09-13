// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { browserOs, platform } from '../src/lib/platform.js';
import { previewAddress } from '../src/lib/native.js';
import { baseName, compactPath, dirName, isInside, portablePath, relativePath, shellQuote } from '../src/terminals/files.js';

test('browser fallback distinguishes the three desktop systems', () => {
  assert.equal(browserOs('Mozilla Macintosh'), 'macos');
  assert.equal(browserOs('Mozilla Windows NT 10.0'), 'windows');
  assert.equal(browserOs('Mozilla X11 Linux x86_64'), 'linux');
  assert.equal(typeof platform().home, 'string');
});

test('portable path helpers accept both separators', () => {
  assert.equal(baseName('C:\\Users\\Ana\\Projeto'), 'Projeto');
  assert.equal(dirName('C:\\Users\\Ana\\Projeto'), 'C:/Users/Ana');
  assert.ok(isInside('C:\\Users\\Ana', 'C:/Users/Ana/Projeto'));
  assert.equal(relativePath('C:\\Users\\Ana', 'C:/Users/Ana/Projeto'), 'Projeto');
  assert.equal(portablePath('\\\\?\\UNC\\servidor\\pasta'), '//servidor/pasta');
  assert.equal(compactPath('/muito/longo/para/um/projeto'), '…/um/projeto');
});

test('preview address uses the WebView2 localhost form only on Windows', () => {
  assert.equal(previewAddress('p123', 'site/index.html', 'macos'), 'preview://p123/site/index.html');
  assert.equal(previewAddress('p123', 'site/index.html', 'linux'), 'preview://p123/site/index.html');
  assert.equal(previewAddress('p123', 'site/index.html', 'windows'), 'http://preview.localhost/p123/site/index.html');
});

test('shell quoting follows posix, PowerShell and cmd contracts', () => {
  assert.equal(shellQuote("/tmp/d'água", 'posix'), "'/tmp/d'\\''água'");
  assert.equal(shellQuote("C:\\Meu d'água", 'powershell'), "'C:\\Meu d''água'");
  assert.equal(shellQuote('C:\\Meu Projeto', 'cmd'), '"C:\\Meu Projeto"');
  assert.equal(shellQuote('=comando', 'posix'), "'=comando'");
  assert.equal(shellQuote("C:\\Ana's", 'powershell'), "'C:\\Ana''s'");
  assert.equal(shellQuote('C:\\A&B', 'cmd'), '"C:\\A&B"');
});
