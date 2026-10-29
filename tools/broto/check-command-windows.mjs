// SPDX-License-Identifier: Apache-2.0
// Native argv proof: compare cialai.exe with direct execution of its sidecar.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('SKIP Broto command Windows: requires native cmd.exe and PowerShell');
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'cialai-command-proof-'));
const bundleDir = join(dir, 'bundle with spaces %literal%!');
mkdirSync(bundleDir);
const recorder = join(bundleDir, 'cialai-tunnel.exe');
const result = join(dir, 'argv.json');
const source = join(dir, 'recorder.go');
const wrapper = join(bundleDir, 'cialai.exe');
const quoteBatchPath = value => `"${value.replaceAll('%', '%%')}"`;
// Win32 CRT quoting. The shell is tested independently against the recorder.
const quoteArg = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
const env = { ...process.env, CIALAI_ARGV_RESULT: result };
const cases = [
  ['spaces', ['broto', 'rodar', 'Windows de teste', 'Write-Output hello world']],
  ['quotes', ['broto', 'rodar', '1', 'Write-Output "quoted text"']],
  ['operators', ['broto', 'rodar', '1', 'echo left & echo right | echo tail']],
  ['literal expansion', ['broto', 'rodar', '1', 'echo %CIALAI_PROOF_UNDEFINED% !CIALAI_PROOF_UNDEFINED! ^ caret']],
  ['program arguments', ['broto', 'rodar', '1', '--programa', 'tool.exe', '--', '--json', 'two words', 'a&b', 'a|b', 'a^b', 'a!b', 'a%b', 'a"b']],
  ['quoted operators', ['broto', 'rodar', '1', 'Write-Output "quoted & piped | text"']],
];
const passed = [];
try {
  writeFileSync(source, 'package main\nimport("encoding/json";"os")\nfunc main(){ b,e:=json.Marshal(os.Args[1:]); if e!=nil{panic(e)};if e=os.WriteFile(os.Getenv("CIALAI_ARGV_RESULT"),b,0600);e!=nil{panic(e)};os.Exit(17)}\n');
  if (process.env.CIALAI_ARGV_RECORDER_EXE) copyFileSync(process.env.CIALAI_ARGV_RECORDER_EXE, recorder);
  else {
    const built = spawnSync('go', ['build', '-o', recorder, source], { encoding: 'utf8', env, timeout: 120000 });
    assert.equal(built.status, 0, built.stderr || built.error?.message);
  }
  const native = process.env.CIALAI_NATIVE_COMMAND_EXE || resolve('apps/desktop/src-tauri/binaries/cialai-command-x86_64-pc-windows-msvc.exe');
  assert.ok(existsSync(native), 'Build the native command with tools/build-tunnel.mjs first');
  copyFileSync(native, wrapper);
  writeFileSync(join(bundleDir, 'cialai-command.json'), JSON.stringify({ marker: 'cialai-command-native-v3', launcher: join(dir, 'unused.exe'), sidecar: recorder }));
  for (const shell of ['cmd', 'powershell']) {
    for (const [name, args] of cases) {
      for (const [kind, executable] of [['direct', recorder], ['native', wrapper]]) {
        if (existsSync(result)) rmSync(result);
        const callEnv = { ...env, CIALAI_PROOF_EXE: executable, CIALAI_PROOF_ARGS: JSON.stringify(args), CIALAI_PROOF_ENCODED: args.map(quoteArg).join(' ') };
        let processResult;
        if (shell === 'cmd') {
          // Delayed expansion inserts the caller's data once. The wrapper must
          // preserve the data it receives without another shell parse.
          const caller = join(dir, 'caller.cmd');
          writeFileSync(caller, '@echo off\r\nsetlocal EnableDelayedExpansion\r\n"!CIALAI_PROOF_EXE!" !CIALAI_PROOF_ENCODED!\r\nexit /b !errorlevel!\r\n');
          processResult = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', `""${caller}""`], { env: callEnv, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 15000 });
        } else {
          const caller = join(dir, 'caller.ps1');
          // Windows PowerShell uses legacy native parsing. Escape embedded
          // quotes at that documented native boundary, also for the baseline.
          writeFileSync(caller, '$a = @(ConvertFrom-Json $env:CIALAI_PROOF_ARGS) | ForEach-Object { $_.Replace(\'"\', \'\\"\') }\n& $env:CIALAI_PROOF_EXE @a\nexit $LASTEXITCODE\n');
          processResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', caller], { env: callEnv, encoding: 'utf8', timeout: 15000 });
        }
        assert.equal(processResult.status, 17, `${shell} ${kind} ${name}: exit mismatch ${processResult.stderr || processResult.error?.message || ''}`);
        assert.ok(existsSync(result), `${shell} ${kind} ${name}: argv recorder was not called`);
        assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), args, `${shell} ${kind} ${name}: argument corruption`);
      }
      passed.push(`${shell}: ${name}`);
    }
  }
  // A caret protects metacharacters in the caller. Native forwarding must
  // never turn them into a second local command.
  for (const [kind, executable] of [['direct', recorder], ['native', wrapper]]) {
    const marker = join(dir, 'unexpected-local-command.txt');
    if (existsSync(result)) rmSync(result);
    if (existsSync(marker)) rmSync(marker);
    const caller = join(dir, 'escaped-caller.cmd');
    const command = `${quoteBatchPath(executable)} broto rodar 1 arg^&echo BROTO_SENTINEL ^>${quoteBatchPath(marker)}`;
    writeFileSync(caller, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${command}\r\nexit /b %errorlevel%\r\n`);
    const invoked = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', `""${caller}""`], { env, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 15000 });
    assert.equal(existsSync(marker), false, `${kind}: escaped metacharacters executed a local command`);
    assert.equal(invoked.status, 17, `${kind}: escaped metacharacters changed exit status`);
    assert.deepEqual(JSON.parse(readFileSync(result,'utf8')), ['broto','rodar','1','arg&echo','BROTO_SENTINEL',`>${marker}`], `${kind}: escaped unquoted argument corruption`);
  }
  passed.push('cmd: escaped unquoted operators do not execute locally');
  console.log(JSON.stringify({ passed: true, cases: passed, remoteExitCode: 17 }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
