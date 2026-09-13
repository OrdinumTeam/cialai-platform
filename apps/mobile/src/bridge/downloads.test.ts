import { prepareDataDownload, prepareRemoteDownload } from './downloads';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('download validation', () => {
  test('decodes an allowed data URL and forces the matching safe extension', () => {
    expect(prepareDataDownload({ type: 'download', name: '../../final.exe', mime: XLSX,
      dataUrl: `data:${XLSX};base64,AAEC` })).toEqual({
      name: 'final.xlsx', mime: XLSX, bytes: new Uint8Array([0, 1, 2])
    });
  });

  test.each([
    { name: 'segredo.html', mime: 'text/html', dataUrl: 'data:text/html;base64,PGgxPng8L2gxPg==' },
    { name: 'dados.xlsx', mime: XLSX, dataUrl: 'data:text/plain;base64,AA==' },
    { name: 'dados.xlsx', mime: XLSX, dataUrl: `data:${XLSX};base64,%%%` },
    { name: 'dados.txt', mime: 'text/plain', dataUrl: 'xxxxxtext/plain;base64,QQ==' }
  ])('rejects unsafe content', message => {
    expect(() => prepareDataDownload({ type: 'download', ...message })).toThrow();
  });

  test('rejects a data URL larger than the binary limit before decoding', () => {
    const oversized = 'A'.repeat(11_200_000);
    expect(() => prepareDataDownload({ type: 'download', name: 'grande.pdf', mime: 'application/pdf',
      dataUrl: `data:application/pdf;base64,${oversized}` })).toThrow('8 MB');
  });

  test('accepts matching MIME parameters used by text exports', () => {
    expect(prepareDataDownload({ type: 'download', name: 'dados.txt', mime: 'text/plain;charset=utf-8',
      dataUrl: 'data:text/plain;charset=utf-8;base64,b2s=' })).toEqual({
      name: 'dados.txt', mime: 'text/plain', bytes: new Uint8Array([111, 107])
    });
  });

  test('validates a remote URL while preserving its signed query', () => {
    expect(prepareRemoteDownload({ type: 'download', name: '../fatura.tmp', mime: 'application/pdf;charset=binary',
      url: 'https://bucket.example/fatura.pdf?signature=sensitive' })).toEqual({
      name: 'fatura.pdf', mime: 'application/pdf', url: 'https://bucket.example/fatura.pdf?signature=sensitive'
    });
  });

  test('infers an allowlisted MIME from the URL download file name', () => {
    expect(prepareRemoteDownload({ type: 'download', name: 'dados.xlsx',
      url: 'https://bucket.example/download?signature=sensitive' })).toEqual({
      name: 'dados.xlsx', mime: XLSX, url: 'https://bucket.example/download?signature=sensitive'
    });
  });

  test.each([
    ['ata.md', 'text/markdown'],
    ['comprovante.jpg', 'image/jpeg'],
    ['comprovante.jpeg', 'image/jpeg'],
    ['custos.csv', 'text/csv']
  ])('infers the real export type for %s', (name, mime) => {
    expect(prepareRemoteDownload({ type: 'download', name,
      url: 'https://bucket.example/download?signature=sensitive' })).toEqual({
      name, mime, url: 'https://bucket.example/download?signature=sensitive'
    });
  });

  test.each([
    'http://bucket.example/fatura.pdf',
    'javascript:alert(1)',
    'https://user:secret@bucket.example/fatura.pdf',
    'https://bucket.example/fatura.pdf#fragment'
  ])('rejects an unsafe remote download URL', url => {
    expect(() => prepareRemoteDownload({ type: 'download', name: 'fatura.pdf',
      mime: 'application/pdf', url })).toThrow();
  });
});
