// SPDX-License-Identifier: Apache-2.0
// Partes do roteiro que mudam por sistema e sabor de shell, sem dependências,
// para serem conferidas também fora do app.

export const PTY_MARKER = 'CIALAI_SELFTEST_PTY';

// Prazos da partida a frio nos runners de CI, em que a primeira abertura do
// webview monta caches antes de desenhar o terminal.
export const TERMINAL_READY_MS = 60000;
// Um shell ainda iniciando pode descartar o que foi digitado antes de ler a
// linha; o comando do marcador é repetido em vez de esperar indefinidamente.
export const PTY_OUTPUT_MS = 10000;
export const PTY_ATTEMPTS = 3;

// O comando digitado nunca contém o marcador literal: só a saída do shell o
// forma, então o eco da linha não aprova o PTY por engano.
const PTY_COMMANDS = {
  posix: "printf 'CIALAI_%s\\n' SELFTEST_PTY\r",
  powershell: "Write-Output ('CIALAI_' + 'SELFTEST_PTY')\r",
  cmd: 'echo CIALAI_^SELFTEST_PTY\r',
};

export function ptyMarkerCommand(flavor) {
  return PTY_COMMANDS[flavor] || PTY_COMMANDS.posix;
}

// Metadados que a listagem de cada sistema precisa esconder.
const NOISE = {
  macos: ['.DS_Store', '._oculto.txt'],
  linux: ['.DS_Store', '.directory'],
  windows: ['Thumbs.db', 'desktop.ini'],
};

export function noiseFixtures(os) {
  return [...(NOISE[os] || NOISE.linux)];
}

// Fim do caminho citado, com a aspa de fechamento do shell.
export function quotedTail(quoted) {
  const text = String(quoted);
  return text.slice(text.lastIndexOf('/'));
}

// Mensagens de comando inexistente em POSIX, PowerShell e cmd.
export const EXECUTED_PATH = /command not found|not found|is not recognized|não é reconhecido/i;
