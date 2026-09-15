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
});
