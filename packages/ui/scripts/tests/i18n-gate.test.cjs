// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const { test } = require('node:test');

test('i18n gate covers all interfaces and rejects visible literals', async () => {
  const gate = await import('../check-mobile-i18n.mjs');
  const roots = gate.SOURCE_ROOTS.map((root) => root.replaceAll('\\', '/'));
  assert.ok(roots.some((root) => root.endsWith('/packages/ui/src/mobile')));
  assert.ok(roots.some((root) => root.endsWith('/packages/ui/src/desktop')));
  assert.ok(roots.some((root) => root.endsWith('/packages/ui/src/components')));
  assert.ok(roots.some((root) => root.endsWith('/packages/ui/src/views')));
  assert.ok(roots.some((root) => root.endsWith('/packages/ui/src/terminals')));
  assert.ok(roots.some((root) => root.endsWith('/packages/ui/src/shared')));
  assert.ok(roots.some((root) => root.endsWith('/apps/mobile')));

  assert.deepEqual(gate.inspectSource('<Text>Olá mundo</Text>', 'fixture.tsx'), [
    'fixture.tsx:1: texto JSX sem chave: Olá mundo',
  ]);
  assert.deepEqual(gate.inspectSource("<Text>{t('mobile.settings.title')}</Text>", 'fixture.tsx'), []);
  assert.deepEqual(gate.inspectSource("<Text>{t('missing.key')}</Text>", 'fixture.tsx'), [
    'fixture.tsx:1: chave desconhecida: missing.key',
  ]);

  assert.deepEqual(gate.inspectSource("<Text>{busy ? 'Salvando' : 'Pronto'}</Text>", 'fixture.tsx'), [
    'fixture.tsx:1: texto JSX condicional sem chave: Salvando',
    'fixture.tsx:1: texto JSX condicional sem chave: Pronto',
  ]);
  assert.deepEqual(gate.inspectSource("<Pressable accessibilityLabel={busy ? 'Cancelar' : 'Abrir'} />", 'fixture.tsx'), [
    'fixture.tsx:1: propriedade acessivel condicional sem chave: Cancelar',
    'fixture.tsx:1: propriedade acessivel condicional sem chave: Abrir',
  ]);
  assert.deepEqual(gate.inspectSource("Alert.alert(t('mobile.alert.downloadFailed.title'), 'Falhou')", 'fixture.tsx'), [
    'fixture.tsx:1: mensagem nativa sem chave: Falhou',
  ]);
  assert.deepEqual(gate.inspectSource("Alert.alert(t('mobile.alert.downloadFailed.title'), t('mobile.alert.downloadFailed.detail'), [{ text: 'Cancelar' }])", 'fixture.tsx'), [
    'fixture.tsx:1: botao nativo sem chave: Cancelar',
  ]);
  assert.deepEqual(gate.inspectSource('<Text>{t(`missing.key`)}</Text>', 'fixture.tsx'), [
    'fixture.tsx:1: chave desconhecida: missing.key',
  ]);
  assert.deepEqual(gate.inspectSource('<Text>{t(`missing.${kind}`)}</Text>', 'fixture.tsx'), [
    'fixture.tsx:1: familia de chave desconhecida: missing.',
  ]);
  assert.deepEqual(gate.inspectSource("const label = 'Salvar'; <Text>{label}</Text>", 'fixture.tsx'), [
    'fixture.tsx:1: texto JSX entre chaves sem chave: Salvar',
  ]);
  assert.deepEqual(gate.inspectSource("notify('Falhou')", 'fixture.tsx'), [
    'fixture.tsx:1: notificacao sem chave: Falhou',
  ]);
  assert.deepEqual(gate.inspectSource("throw new Error('Falhou')", 'fixture.tsx'), [
    'fixture.tsx:1: mensagem de erro sem chave: Falhou',
  ]);
  assert.deepEqual(gate.inspectSource('<DataState type="loading" message="Carregando arquivos" />', 'fixture.jsx'), [
    'fixture.jsx:1: propriedade visivel sem chave: Carregando arquivos',
  ]);
  assert.deepEqual(gate.inspectSource('<Segmented ariaLabel="Idioma" options={options} />', 'fixture.jsx'), [
    'fixture.jsx:1: propriedade visivel sem chave: Idioma',
  ]);
  assert.deepEqual(gate.inspectSource('<img alt="Marca do estúdio" src={logo} />', 'fixture.jsx'), [
    'fixture.jsx:1: propriedade visivel sem chave: Marca do estúdio',
  ]);
  assert.deepEqual(gate.inspectSource("chooseDirectory({ title: 'Abrir sessão em' })", 'fixture.js'), [
    'fixture.js:1: mensagem de configuração sem chave: Abrir sessão em',
  ]);
  assert.deepEqual(gate.inspectSource("window.confirm('Sair agora?'); alert('Pronto')", 'fixture.js'), [
    'fixture.js:1: dialogo do navegador sem chave: Sair agora?',
    'fixture.js:1: dialogo do navegador sem chave: Pronto',
  ]);
  assert.deepEqual(gate.inspectSource('<Row title={t("desktop.preferences.title")} className="mac-row" type="button" />', 'fixture.jsx'), []);
  assert.deepEqual(gate.inspectSource("const hints = { placeholder: '-NoLogo', kind: 'new-dir', title: 'mobile.offline.tunnel.title' };", 'fixture.js'), []);
});

test('i18n gate requires the three languages with the same keys, values and placeholders', async () => {
  const gate = await import('../check-mobile-i18n.mjs');
  const valid = {
    'pt-BR': { 'demo.saved': '{name} salvo', 'demo.title': 'Título' },
    en: { 'demo.saved': '{name} saved', 'demo.title': 'Title' },
    es: { 'demo.saved': '{name} guardado', 'demo.title': 'Título' },
  };
  assert.deepEqual(gate.checkDictionaries(valid), []);
  assert.deepEqual(gate.checkDictionaries({ 'pt-BR': valid['pt-BR'], en: valid.en }), ['idiomas esperados pt-BR, en, es; encontrados pt-BR, en']);
  assert.deepEqual(gate.checkDictionaries({ ...valid, es: { 'demo.saved': '{nombre} guardado' } }), [
    'dicionario es nao possui as mesmas chaves de pt-BR',
    'placeholders de es diferem em demo.saved',
  ]);
  assert.deepEqual(gate.checkDictionaries({ ...valid, en: { ...valid.en, 'demo.title': '  ' } }), ['valor vazio em en: demo.title']);
});

test('i18n gate checks placeholders at call sites and reports unused keys', async () => {
  const gate = await import('../check-mobile-i18n.mjs');
  assert.deepEqual(gate.inspectSource("notify(t('terminal.session.saved'))", 'fixture.js'), [
    'fixture.js:1: valores ausentes para terminal.session.saved: name',
  ]);
  assert.deepEqual(gate.inspectSource("notify(t('terminal.session.saved', { name }))", 'fixture.js'), []);
  assert.deepEqual(gate.inspectSource("notify(t('terminal.session.saved', { title: name }))", 'fixture.js'), [
    'fixture.js:1: valores ausentes para terminal.session.saved: name',
  ]);
  assert.deepEqual(gate.inspectSource("notify(t('terminal.session.saved', { ...values }))", 'fixture.js'), []);
  assert.deepEqual(gate.inspectSource("notify(t(ok ? 'terminal.session.saved' : 'terminal.common.copyFailed', { name }))", 'fixture.js'), []);

  const usage = gate.collectKeyUsage("t('demo.used'); const KEYS = { a: 'demo.mapped' }; t(`demo.family.${id}`);");
  assert.ok(gate.USAGE_ROOTS.some((root) => root.replaceAll('\\', '/').endsWith('/apps/desktop/src-tauri/src')));
  assert.deepEqual([...gate.collectRustKeyUsage('let title = t("native.quit.title"); // "comentario livre"').literals], ['native.quit.title', 'comentario livre']);
  assert.deepEqual(gate.unusedKeys(['demo.used', 'demo.mapped', 'demo.family.one', 'demo.dead'], [usage]), ['demo.dead']);
});
