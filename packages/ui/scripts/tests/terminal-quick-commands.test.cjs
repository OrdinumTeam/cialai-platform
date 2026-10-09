// SPDX-License-Identifier: Apache-2.0
// Comandos rápidos e preferências do teclado especial, guardados no
// localStorage da página.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadCommands = () => import('../../src/terminals/quick-commands.js');
const loadPrefs = () => import('../../src/terminals/keyboard-prefs.js');

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); }, removeItem: (key) => { map.delete(key); }, map };
}

test('sem nada guardado aparecem os quatro exemplos, sem execução automática', async () => {
  const { readCommands } = await loadCommands();
  const commands = readCommands(memoryStorage());
  assert.deepEqual(commands.map((entry) => entry.command), ['git status', 'git pull', 'npm run dev', 'docker compose up']);
  assert.ok(commands.every((entry) => entry.confirm === false));
});

test('cadastrar, editar, remover e reordenar persistem', async () => {
  const { readCommands, writeCommands, saveCommand, removeCommand, moveCommand, QUICK_COMMANDS_KEY } = await loadCommands();
  const storage = memoryStorage();
  let commands = readCommands(storage);
  const created = saveCommand(commands, { command: '  python app.py ', label: 'App', description: 'Rodar a aplicação' }, () => 'cmd-app');
  assert.equal(created.error, undefined);
  commands = writeCommands(storage, created.commands);
  assert.deepEqual(commands.at(-1), { id: 'cmd-app', command: 'python app.py', label: 'App', description: 'Rodar a aplicação', confirm: false });
  commands = writeCommands(storage, saveCommand(commands, { ...commands.at(-1), command: 'python3 app.py', confirm: true }).commands);
  assert.equal(commands.at(-1).command, 'python3 app.py');
  assert.equal(commands.at(-1).confirm, true);
  commands = writeCommands(storage, moveCommand(commands, 'cmd-app', -1));
  assert.equal(commands.at(-2).id, 'cmd-app');
  assert.equal(moveCommand(commands, commands[0].id, -1), commands, 'o primeiro não sobe');
  commands = writeCommands(storage, removeCommand(commands, 'seed-git-pull'));
  assert.ok(storage.map.has(QUICK_COMMANDS_KEY));
  assert.deepEqual(readCommands(storage).map((entry) => entry.id), ['seed-git-status', 'seed-npm-dev', 'cmd-app', 'seed-compose-up']);
  writeCommands(storage, []);
  assert.deepEqual(readCommands(storage), [], 'lista vazia continua vazia, sem voltar aos exemplos');
});

test('senhas e tokens são recusados no salvamento e descartados na leitura', async () => {
  const { saveCommand, containsSecret, readCommands, QUICK_COMMANDS_KEY } = await loadCommands();
  for (const command of [
    'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstu', 'mysql -u root -psecret', 'curl -H "Authorization: Bearer abc.def.ghi.jkl" api',
    'git clone https://user:hunter2@github.com/x/y', 'psql --password=hunter2', 'aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP',
    'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv codex', 'login --token abc123',
  ]) {
    assert.equal(containsSecret(command), true, command);
    assert.equal(saveCommand([], { command }).error, 'terminal.phone.quick.error.secret', command);
  }
  for (const command of ['echo $TOKEN', 'gh auth login', 'npm run dev -- --port 3000', 'psql postgres://app@localhost/db', 'git pull --rebase']) {
    assert.equal(containsSecret(command), false, command);
  }
  const storage = memoryStorage({ [QUICK_COMMANDS_KEY]: JSON.stringify([{ id: 'x', command: 'export API_KEY=abc' }, { id: 'y', command: 'ls' }]) });
  assert.deepEqual(readCommands(storage).map((entry) => entry.id), ['y']);
});

test('comandos destrutivos pedem confirmação', async () => {
  const { isDestructive, needsConfirmation } = await loadCommands();
  for (const command of ['rm -rf dist', 'rm -f a.txt', 'git reset --hard HEAD~1', 'git push --force', 'git push -f origin main', 'git clean -fd', 'docker system prune -a', 'docker compose down -v', 'sudo systemctl restart nginx', 'kill -9 1234', 'DROP TABLE users;', 'chmod -R 777 .', 'git checkout .', 'git branch -D feature']) {
    assert.equal(isDestructive(command), true, command);
  }
  for (const command of ['git status', 'git pull', 'npm run dev', 'docker compose up', 'rm notes.txt', 'git push', 'ls -rf']) {
    assert.equal(isDestructive(command), false, command);
  }
  assert.equal(needsConfirmation({ command: 'make deploy', confirm: true }), true);
});

test('validação, limite e storage corrompido', async () => {
  const { saveCommand, readCommands, filterCommands, QUICK_COMMANDS_KEY, MAX_COMMANDS } = await loadCommands();
  assert.equal(saveCommand([], { command: '   ' }).error, 'terminal.phone.quick.error.empty');
  assert.equal(saveCommand([], { command: 'x'.repeat(2001) }).error, 'terminal.phone.quick.error.tooLong');
  const full = Array.from({ length: MAX_COMMANDS }, (_, index) => ({ id: `c${index}`, command: 'ls', label: '', description: '', confirm: false }));
  assert.equal(saveCommand(full, { command: 'pwd' }).error, 'terminal.phone.quick.error.full');
  assert.equal(readCommands(memoryStorage({ [QUICK_COMMANDS_KEY]: '{nao é json' })).length, 4);
  assert.equal(readCommands(memoryStorage({ [QUICK_COMMANDS_KEY]: JSON.stringify([{ id: 'a', command: 'ls' }, { id: 'a', command: 'pwd' }, { command: 'x' }, 7]) })).length, 1);
  const commands = readCommands(memoryStorage());
  assert.deepEqual(filterCommands(commands, 'GIT').map((entry) => entry.command), ['git status', 'git pull']);
  assert.deepEqual(filterCommands(commands, 'reposito', () => 'Repositório').length, 4);
});

test('preferências do teclado: padrão, gravação e valores inválidos', async () => {
  const { readKeyboardPrefs, writeKeyboardPrefs, defaultKeyboardPrefs, toggleFavorite, moveFavorite, KEYBOARD_PREFS_KEY, MAX_FAVORITES } = await loadPrefs();
  const storage = memoryStorage();
  assert.deepEqual(readKeyboardPrefs(storage), defaultKeyboardPrefs());
  assert.deepEqual(defaultKeyboardPrefs().favorites, ['Escape', 'Tab', 'CtrlV'], 'Colar já vem na barra, depois do Tab');
  // Com a barra cheia, uma tecla nova só entra quando outra sai.
  assert.deepEqual(toggleFavorite(readKeyboardPrefs(storage), 'CtrlC').favorites, ['Escape', 'Tab', 'CtrlV']);
  let prefs = toggleFavorite(toggleFavorite(readKeyboardPrefs(storage), 'CtrlV'), 'CtrlC');
  prefs = moveFavorite(prefs, 'CtrlC', -1);
  prefs = writeKeyboardPrefs(storage, { ...prefs, modifierMode: 'sticky', haptics: true, autoOpen: true });
  assert.deepEqual(readKeyboardPrefs(storage), { favorites: ['Escape', 'CtrlC', 'Tab'], modifierMode: 'sticky', haptics: true, autoOpen: true });
  assert.equal(toggleFavorite(prefs, 'Enter').favorites.length, MAX_FAVORITES, 'a barra tem teto');
  assert.deepEqual(toggleFavorite(prefs, 'Tab').favorites, ['Escape', 'CtrlC']);
  const broken = memoryStorage({ [KEYBOARD_PREFS_KEY]: JSON.stringify({ favorites: ['ArrowUp', 'Nope', 'Tab', 'Tab'], modifierMode: 'x', haptics: 'yes' }) });
  assert.deepEqual(readKeyboardPrefs(broken), { favorites: ['Tab'], modifierMode: 'oneShot', haptics: false, autoOpen: false });
  assert.deepEqual(readKeyboardPrefs(memoryStorage({ [KEYBOARD_PREFS_KEY]: '{' })), defaultKeyboardPrefs());
  assert.deepEqual(readKeyboardPrefs(null), defaultKeyboardPrefs());
});

test('todas as teclas das abas existem no catálogo e geram sequência', async () => {
  const { KEYBOARD_TABS, KEY_CATALOG, FAVORITE_CHOICES, SYMBOLS, PASTE_KEY } = await loadPrefs();
  const { encodeKey } = await import('../../src/terminals/key-encoder.js');
  const ids = [...KEYBOARD_TABS.flatMap((tab) => tab.keys), ...FAVORITE_CHOICES];
  for (const id of ids) {
    assert.ok(KEY_CATALOG[id], id);
    if (id !== PASTE_KEY) assert.ok(encodeKey(KEY_CATALOG[id].key, KEY_CATALOG[id].mods), id);
  }
  for (const symbol of SYMBOLS) assert.equal(encodeKey(symbol), symbol);
});
