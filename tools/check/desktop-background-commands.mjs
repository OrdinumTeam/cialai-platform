// SPDX-License-Identifier: Apache-2.0
// Processos auxiliares do desktop sem janela. Em release no Windows o app é
// subsistema GUI e não tem console, então todo filho de console criado sem
// CREATE_NO_WINDOW abre uma janela visível. Por isso cada `Command::new(` de
// produção em apps/desktop/src-tauri/src precisa chamar
// `platform::configure_background_command` na mesma função. Módulos
// `#[cfg(test)]` e funções `#[test]` ficam de fora. Um caso legítimo é
// dispensado com um comentário na própria linha ou na anterior:
//   // sem CREATE_NO_WINDOW: <motivo>
// O mesmo check confere a defesa em profundidade do sidecar Go, que sai como
// subsistema GUI no Windows por `-H=windowsgui`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = path.join(root, 'apps/desktop/src-tauri/src');
export const HELPER = 'configure_background_command';
export const EXEMPTION = 'sem CREATE_NO_WINDOW:';
const SPAWN = 'Command::new(';

function rustFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return rustFiles(full);
    return entry.name.endsWith('.rs') ? [full] : [];
  });
}

// Apaga comentários e o conteúdo de strings, strings cruas e chars, mantendo o
// tamanho e as quebras de linha, para chaves e nomes dentro de texto não
// confundirem o pareamento nem a busca.
export function blank(source) {
  const out = Array.from(source);
  const erase = (index) => { if (out[index] !== '\n') out[index] = ' '; };
  const length = source.length;
  let i = 0;
  while (i < length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      while (i < length && source[i] !== '\n') { erase(i); i += 1; }
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 0;
      do {
        if (source[i] === '/' && source[i + 1] === '*') { depth += 1; erase(i); erase(i + 1); i += 2; continue; }
        if (source[i] === '*' && source[i + 1] === '/') { depth -= 1; erase(i); erase(i + 1); i += 2; continue; }
        erase(i); i += 1;
      } while (i < length && depth > 0);
      continue;
    }
    const identifierBefore = i > 0 && /[A-Za-z0-9_]/.test(source[i - 1]);
    const raw = /^b?r(#*)"/.exec(source.slice(i, i + 12));
    if (raw && !identifierBefore) {
      const close = `"${raw[1]}`;
      const start = i + raw[0].length;
      const end = source.indexOf(close, start);
      const stop = end === -1 ? length : end;
      for (let k = start; k < stop; k += 1) erase(k);
      i = end === -1 ? length : end + close.length;
      continue;
    }
    if ((char === '"' || (char === 'b' && next === '"')) && !(char === 'b' && identifierBefore)) {
      let k = char === 'b' ? i + 2 : i + 1;
      while (k < length && source[k] !== '"') {
        if (source[k] === '\\') { erase(k); k += 1; }
        erase(k); k += 1;
      }
      i = k + 1;
      continue;
    }
    if (char === '\'' || (char === 'b' && next === '\'' && !identifierBefore)) {
      const start = char === 'b' ? i + 1 : i;
      const literal = /^'(\\.[^']*|[^\\'])'/.exec(source.slice(start, start + 16));
      if (literal) {
        for (let k = start + 1; k < start + literal[0].length - 1; k += 1) erase(k);
        i = start + literal[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out.join('');
}

// Fim do bloco que abre na chave em `open`, ou o fim do texto.
function blockEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

// Primeira chave de bloco depois de `from`, a menos que um `;` venha antes.
function bodyOpen(text, from) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '{') return i;
    if (text[i] === ';') return -1;
  }
  return -1;
}

function testRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(/#\[cfg\((?:all\()?test\b[^\]]*\]/g)) {
    const open = bodyOpen(text, match.index + match[0].length);
    if (open !== -1) ranges.push([match.index, blockEnd(text, open)]);
  }
  for (const match of text.matchAll(/#\[(?:tokio::)?test(?:\([^)]*\))?\]/g)) {
    const fn = /\bfn\s+[A-Za-z_]\w*/g;
    fn.lastIndex = match.index;
    const declaration = fn.exec(text);
    if (!declaration) continue;
    const open = bodyOpen(text, declaration.index + declaration[0].length);
    if (open !== -1) ranges.push([match.index, blockEnd(text, open)]);
  }
  return ranges;
}

function functionRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(/\bfn\s+[A-Za-z_]\w*/g)) {
    const open = bodyOpen(text, match.index + match[0].length);
    if (open !== -1) ranges.push([match.index, blockEnd(text, open)]);
  }
  return ranges;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const lineText = (text, line) => text.split('\n')[line - 1] ?? '';

// Problemas de um arquivo Rust: cada `Command::new(` de produção cuja função
// não chama o helper e que não traz a dispensa justificada.
export function inspect(source, file) {
  const text = blank(source);
  const tests = testRanges(text);
  const functions = functionRanges(text);
  const problems = [];
  let index = text.indexOf(SPAWN);
  while (index !== -1) {
    const line = lineOf(text, index);
    const inTests = tests.some(([start, end]) => index >= start && index <= end);
    if (!inTests) {
      const owner = functions
        .filter(([start, end]) => index >= start && index <= end)
        .sort((left, right) => right[0] - left[0])[0];
      const covered = owner && text.slice(owner[0], owner[1] + 1).includes(HELPER);
      const exempt = lineText(source, line).includes(EXEMPTION) || lineText(source, line - 1).includes(EXEMPTION);
      if (!covered && !exempt) {
        problems.push(`${file}:${line}: Command::new sem ${HELPER} na mesma função e sem "${EXEMPTION} motivo"`);
      }
    }
    index = text.indexOf(SPAWN, index + SPAWN.length);
  }
  return problems;
}

// Contrato do próprio check.
const fixture = `
fn covered() -> Command {
    let mut command = Command::new("git");
    platform::configure_background_command(&mut command);
    command
}
fn uncovered() {
    let _ = Command::new("git").output(); // { chave em comentário
}
fn quoted() -> &'static str { "Command::new(" }
fn exempt_before() {
    // sem CREATE_NO_WINDOW: só no macOS, sem console para filhos.
    let _ = std::process::Command::new("/usr/sbin/scutil").output();
}
fn exempt_same_line() { let _ = Command::new("x"); // sem CREATE_NO_WINDOW: teste do check
}
fn escaped_quote() { let text = "a \\"} b"; let raw = r#"}{"#; let byte = b'{'; let ch = '\\''; let _ = Command::new("y"); }
#[cfg(unix)]
#[test]
#[ignore = "manual"]
fn standalone_test() { let _ = Command::new("pmset"); }
#[cfg(test)]
mod tests {
    fn helper() { let _ = Command::new("git"); }
    #[test]
    fn spawns() { let _ = Command::new("sh"); }
}
`;
assert.deepEqual(inspect(fixture, 'fixture.rs'), [
  'fixture.rs:8: Command::new sem configure_background_command na mesma função e sem "sem CREATE_NO_WINDOW: motivo"',
  'fixture.rs:17: Command::new sem configure_background_command na mesma função e sem "sem CREATE_NO_WINDOW: motivo"',
]);
assert.equal(blank('let a = "x{"; let b = \'{\'; // }\n'), 'let a = "  "; let b = \' \';     \n');

const problems = [];
let spawns = 0;
for (const file of rustFiles(sourceRoot)) {
  const source = readFileSync(file, 'utf8');
  spawns += (blank(source).match(/Command::new\(/g) || []).length;
  problems.push(...inspect(source, path.relative(root, file)));
}
assert.ok(spawns > 0, 'nenhum Command::new encontrado no crate do desktop');
assert.deepEqual(problems, [], `Processos auxiliares sem CREATE_NO_WINDOW:\n${problems.join('\n')}`);

// O helper existe com a flag do Windows e o grupo de processos do Unix.
const platform = readFileSync(path.join(sourceRoot, 'platform/mod.rs'), 'utf8');
assert.match(platform, /pub fn configure_background_command\(command: &mut Command\)/);
assert.match(platform, /creation_flags\(CREATE_NO_WINDOW\)/);
assert.match(platform, /command\.process_group\(0\)/);

// Defesa em profundidade: o sidecar Go do Windows é subsistema GUI.
const { goLdflags } = await import(pathToFileURL(`${root}tools/build-tunnel.mjs`).href);
assert.equal(goLdflags('windows'), '-s -w -H=windowsgui');
assert.equal(goLdflags('linux'), '-s -w');
assert.equal(goLdflags('darwin'), '-s -w');

console.log(`PASS desktop background commands: ${spawns} Command::new no crate, todos com ${HELPER} ou dispensa justificada, e sidecar Windows sem console`);
