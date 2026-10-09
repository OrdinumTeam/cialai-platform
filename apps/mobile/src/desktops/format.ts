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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Translate = (key: string, values?: Record<string, string | number>) => string;

// Tempo até a renovação do limite, curto para caber no card: "2 h 10 min",
// "45 min" ou "3 d 4 h". Nulo sem horário ou com o horário já passado. Os
// textos vêm do dicionário porque o Intl de unidades varia entre motores.
export function formatDuration(ms: number, t: Translate): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const days = (count: number) => t('mobile.duration.days', { count });
  const hours = (count: number) => t('mobile.duration.hours', { count });
  const minutes = (count: number) => t('mobile.duration.minutes', { count });
  if (ms >= DAY) {
    const rest = Math.floor((ms % DAY) / HOUR);
    return rest ? `${days(Math.floor(ms / DAY))} ${hours(rest)}` : days(Math.floor(ms / DAY));
  }
  if (ms >= HOUR) {
    const rest = Math.floor((ms % HOUR) / MINUTE);
    return rest ? `${hours(Math.floor(ms / HOUR))} ${minutes(rest)}` : hours(Math.floor(ms / HOUR));
  }
  return minutes(Math.max(1, Math.round(ms / MINUTE)));
}

export function formatReset(resetsAtMs: number | null, now: number, t: Translate): string | null {
  return resetsAtMs === null ? null : formatDuration(resetsAtMs - now, t);
}

// Idade do retrato: "agora", "há 5 min", "há 2 h" ou a data curta.
export function formatAge(atMs: number, now: number, locale: string, t: Translate): string {
  const age = Math.max(0, now - atMs);
  if (age < MINUTE) return t('mobile.duration.now');
  if (age < DAY) return t('mobile.duration.ago', { time: formatDuration(age, t) ?? '' });
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(atMs));
}

// Quando a janela renova, em hora local: só a hora no mesmo dia, o dia da
// semana com a hora nos próximos dias e a data curta depois disso.
export function formatResetAt(resetsAtMs: number | null, now: number, locale: string): string | null {
  if (resetsAtMs === null || resetsAtMs <= now) return null;
  const date = new Date(resetsAtMs);
  const options: Intl.DateTimeFormatOptions = new Date(now).toDateString() === date.toDateString()
    ? { timeStyle: 'short' }
    : resetsAtMs - now < 6 * DAY ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { dateStyle: 'short', timeStyle: 'short' };
  return new Intl.DateTimeFormat(locale, options).format(date);
}
