// Impressão digital em grupos de quatro caracteres, para conferir com o computador.
export function formatFingerprint(fingerprint: string): string {
  const clean = fingerprint.toLowerCase().replace(/[^0-9a-f]/g, '');
  return clean.match(/.{1,4}/g)?.join(' ') ?? '';
}

export function formatLastSeen(value: string, locale: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
