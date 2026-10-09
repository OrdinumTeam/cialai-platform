import { pageMessageScript, parsePageMessage, shellMessageScript } from './messages';

describe('page bridge messages', () => {
  test('parses bounded auth requests', () => {
    expect(parsePageMessage('{"type":"auth","id":7,"level":"session","reason":"Abrir terminal"}'))
      .toEqual({ type: 'auth', id: 7, level: 'session', reason: 'Abrir terminal' });
  });

  test.each([
    '{"type":"auth","id":0,"level":"session","reason":"Terminal"}',
    '{"type":"auth","id":1,"level":"admin","reason":"Terminal"}',
    '{"type":"auth","id":1,"level":"session","reason":""}',
    '{"type":"auth","id":1,"level":"session","reason":"' + 'a'.repeat(161) + '"}',
    '{"type":"unknown"}',
    'not json'
  ])('rejects a malformed message', raw => {
    expect(parsePageMessage(raw)).toBeNull();
  });

  test('parses download and HTTPS external requests without widening their shape', () => {
    expect(parsePageMessage(JSON.stringify({
      type: 'download', name: 'dados.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dataUrl: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,AA=='
    }))).toEqual({
      type: 'download', name: 'dados.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dataUrl: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,AA=='
    });
    expect(parsePageMessage('{"type":"open-external","url":"https://ordinum.com.br"}'))
      .toEqual({ type: 'open-external', url: 'https://ordinum.com.br' });
    expect(parsePageMessage('{"type":"open-external","url":"javascript:alert(1)"}')).toBeNull();
  });

  test('parses an HTTPS URL download without exposing it to WebView fetch', () => {
    const raw = JSON.stringify({ type: 'download', name: 'dados.pdf',
      url: 'https://signed-storage.example/dados.pdf?signature=sensitive' });
    expect(parsePageMessage(raw)).toEqual({ type: 'download', name: 'dados.pdf',
      url: 'https://signed-storage.example/dados.pdf?signature=sensitive' });
  });

  test('requires MIME for inline data but permits a URL download to infer it from the name', () => {
    expect(parsePageMessage(JSON.stringify({ type: 'download', name: 'dados.txt',
      dataUrl: 'data:text/plain;base64,QQ==' }))).toBeNull();
    expect(parsePageMessage(JSON.stringify({ type: 'download', name: 'dados.txt',
      url: 'https://bucket.example/dados' }))).toEqual({
      type: 'download', name: 'dados.txt', url: 'https://bucket.example/dados'
    });
  });

  test('requires exactly one download source and restricts local HTTP to development', () => {
    const both = JSON.stringify({ type: 'download', name: 'dados.pdf', mime: 'application/pdf',
      url: 'https://signed-storage.example/dados.pdf', dataUrl: 'data:application/pdf;base64,AA==' });
    const local = JSON.stringify({ type: 'download', name: 'dados.pdf', mime: 'application/pdf',
      url: 'http://127.0.0.1:47400/dados.pdf' });
    expect(parsePageMessage(both)).toBeNull();
    expect(parsePageMessage(local)).toBeNull();
    expect(parsePageMessage(local, true)).toEqual({ type: 'download', name: 'dados.pdf', mime: 'application/pdf',
      url: 'http://127.0.0.1:47400/dados.pdf' });
    expect(parsePageMessage(JSON.stringify({ type: 'download', name: 'dados.pdf', mime: 'application/pdf',
      url: 'http://192.168.1.10/dados.pdf' }), true)).toBeNull();
  });

  test('serializes shell state as an inert JavaScript invocation', () => {
    const script = shellMessageScript({ type: 'shell', platform: 'ios', version: '1.0.0',
      desktopId: 'd_test', unlocked: false, theme: 'dark' });
    expect(script).toContain('window.__cialaiShellReceive');
    expect(script).toContain('"unlocked":false');
    expect(script).toContain('"theme":"dark"');
    expect(script.endsWith('true;')).toBe(true);
  });

  test('accepts only the exact navigate back message', () => {
    expect(parsePageMessage('{"type":"navigate-back"}')).toEqual({ type: 'navigate-back' });
    expect(parsePageMessage('{"type":"navigate-back","url":"https://evil.example"}')).toBeNull();
    expect(pageMessageScript({ type: 'navigate-back' })).toContain('navigate-back');
  });

  test('accepts a picked project folder only with a path inside the limit', () => {
    expect(parsePageMessage('{"type":"project-picked","path":"/p/alfa","name":"alfa"}')).toEqual({ type: 'project-picked', path: '/p/alfa', name: 'alfa' });
    expect(parsePageMessage('{"type":"project-picked","path":"","name":"alfa"}')).toBeNull();
    expect(parsePageMessage(JSON.stringify({ type: 'project-picked', path: `/${'x'.repeat(600)}`, name: 'x' }))).toBeNull();
    expect(parsePageMessage('{"type":"project-picked","path":"/p/alfa"}')).toBeNull();
  });

  describe('dashboard snapshot', () => {
    const valid = {
      type: 'dashboard', at: 1000,
      accounts: [{ id: 'codex', agent: 'codex', label: 'Codex', plan: 'plus', active: true, state: 'ok', fetchedAtMs: 900,
        windows: [{ id: 'session', label: 'Limite de 5 horas', usedFraction: 0.19, resetsAtMs: 5000, durationMs: 18000000, headline: true, weekly: false }] }],
      projects: [{ name: 'psicoapp', path: '/p/psicoapp', root: '~/p' }],
      sessions: [{ id: 's1', name: 'psicoapp', cwd: '/p/psicoapp', status: 'running', agent: null }],
      recent: ['/p/psicoapp']
    };

    test('accepts the shape the page sends', () => {
      expect(parsePageMessage(JSON.stringify(valid))).toEqual(valid);
    });

    test('reads a page without recent folders as an empty list', () => {
      const { recent: _recent, ...older } = valid;
      expect(parsePageMessage(JSON.stringify(older))).toEqual({ ...older, recent: [] });
    });

    test('clamps the used fraction', () => {
      const raw = { ...valid, accounts: [{ ...valid.accounts[0], windows: [{ ...valid.accounts[0]!.windows[0], usedFraction: 1.7 }] }] };
      const parsed = parsePageMessage(JSON.stringify(raw));
      expect(parsed?.type === 'dashboard' && parsed.accounts[0]?.windows[0]?.usedFraction).toBe(1);
    });

    test.each([
      ['an unknown agent', { accounts: [{ ...valid.accounts[0], agent: 'gemini' }] }],
      ['an unknown reading state', { accounts: [{ ...valid.accounts[0], state: 'great' }] }],
      ['a fraction that is not a number', { accounts: [{ ...valid.accounts[0], windows: [{ ...valid.accounts[0]!.windows[0], usedFraction: '19%' }] }] }],
      ['a project without path', { projects: [{ name: 'x', path: '', root: '' }] }],
      ['too many projects', { projects: Array.from({ length: 401 }, (_, index) => ({ name: `p${index}`, path: `/p${index}`, root: '' })) }],
      ['a text over the limit', { sessions: [{ ...valid.sessions[0], name: 'x'.repeat(513) }] }],
      ['a missing time', { at: 0 }],
      ['accounts that are not a list', { accounts: {} }],
      ['too many recent folders', { recent: Array.from({ length: 11 }, (_, index) => `/r${index}`) }],
      ['an empty recent folder', { recent: [''] }]
    ])('rejects the whole snapshot with %s', (_name, change) => {
      expect(parsePageMessage(JSON.stringify({ ...valid, ...change }))).toBeNull();
    });
  });
});
