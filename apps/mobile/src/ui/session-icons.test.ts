import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import SquareTerminal from 'lucide-react-native/icons/square-terminal';

import { resolveSessionIcon, SESSION_ICONS, sessionIconFor } from './session-icons';

// Ids do registro do desktop, lidos do próprio arquivo, na ordem da grade.
const desktopIds = () => [...readFileSync(join(__dirname, '../../../../packages/ui/src/terminals/session-icons.js'), 'utf8')
  .matchAll(/\{ id: '([a-z0-9-]+)', Icon: \w+ \}/g)].map(match => match[1]);

describe('session icons', () => {
  test('mirror the desktop registry id for id and in the same order', () => {
    const ids = desktopIds();
    expect(ids).toHaveLength(30);
    expect(Object.keys(SESSION_ICONS)).toEqual(ids);
  });

  test('every id resolves to its own drawing', () => {
    const drawings = Object.keys(SESSION_ICONS).map(id => sessionIconFor(id));
    drawings.forEach(drawing => expect(drawing).toBeTruthy());
    expect(new Set(drawings).size).toBe(drawings.length);
    expect(sessionIconFor('terminal')).toBe(SquareTerminal);
  });

  test('an unknown, missing or inherited id has no drawing', () => {
    for (const id of ['unknown', '', 'toString', '__proto__', null, undefined, 7]) expect(sessionIconFor(id)).toBeNull();
  });

  test('the chosen icon wins, then the agent glyph, then the terminal', () => {
    expect(resolveSessionIcon({ icon: 'rocket', agent: 'claude' })).toEqual({ kind: 'custom', Icon: SESSION_ICONS.rocket });
    expect(resolveSessionIcon({ icon: null, agent: 'claude' })).toEqual({ kind: 'agent', agent: 'claude' });
    expect(resolveSessionIcon({ icon: 'gone', agent: 'codex' })).toEqual({ kind: 'agent', agent: 'codex' });
    expect(resolveSessionIcon({ icon: null, agent: null })).toEqual({ kind: 'default', Icon: SquareTerminal });
  });
});
