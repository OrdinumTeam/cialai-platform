import {
  appendDiagnostic,
  clearDiagnostics,
  DIAGNOSTIC_LOG_CAPACITY,
  formatDiagnosticTime,
  logApp,
  logCore,
  recentDiagnostics,
  subscribeDiagnostics
} from './diagnostics';

describe('diagnostic ring', () => {
  beforeEach(() => clearDiagnostics());

  test('keeps only the most recent lines and tells subscribers', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeDiagnostics(listener);
    for (let index = 0; index < DIAGNOSTIC_LOG_CAPACITY + 5; index += 1) {
      appendDiagnostic({ at: index, level: 'info', message: `line ${index}` });
    }
    const lines = recentDiagnostics();
    expect(lines).toHaveLength(DIAGNOSTIC_LOG_CAPACITY);
    expect(lines[0]?.message).toBe('line 5');
    expect(lines.at(-1)?.message).toBe(`line ${DIAGNOSTIC_LOG_CAPACITY + 4}`);
    expect(listener).toHaveBeenCalledTimes(DIAGNOSTIC_LOG_CAPACITY + 5);
    unsubscribe();
    appendDiagnostic({ at: 1, level: 'info', message: 'after' });
    expect(listener).toHaveBeenCalledTimes(DIAGNOSTIC_LOG_CAPACITY + 5);
  });

  test('marks app lines and keeps core lines as they came', () => {
    logApp('info', 'health probe: HTTP 403', 1_000);
    logCore('debug', 'pathmgr: adopt direct', 2_000);
    expect(recentDiagnostics()).toEqual([
      { at: 1_000, level: 'info', message: 'app: health probe: HTTP 403' },
      { at: 2_000, level: 'debug', message: 'pathmgr: adopt direct' }
    ]);
  });

  test('formats the local time with two digits per field', () => {
    const at = new Date(2026, 8, 16, 7, 5, 9).getTime();
    expect(formatDiagnosticTime(at)).toBe('07:05:09');
  });
});
