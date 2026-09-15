import * as SecureStore from 'expo-secure-store';

import {
  cleanDesktopName,
  deleteDeviceToken,
  emptyDesktopStore,
  findDesktop,
  LEGACY_STORE_FILE,
  legacyDesktopIds,
  loadDesktopStore,
  markDesktopUsed,
  parseDesktopStore,
  readDeviceToken,
  recordPair,
  recordTransport,
  removeDesktop,
  renameDesktop,
  saveDesktopStore,
  saveDeviceToken,
  secureVault,
  STORE_FILE,
  type DesktopStore,
  type StoreFiles,
  type TokenVault
} from './store';

const desktopId = 'd_AAAAAAAAAAAAAAAAAAAAAA';
const otherDesktopId = 'd_BBBBBBBBBBBBBBBBBBBBBB';
const deviceId = 'dev_AAAAAAAAAAAAAAAAAAAAAA';
const token = `cdt1.${deviceId}.${'s'.repeat(43)}`;
const result = {
  desktopId,
  deviceId,
  token,
  desktop: { id: desktopId, name: 'Mac de Foco', fingerprint: '0123456789abcdef' },
  transport: 'direct' as const
};

function paired(): DesktopStore {
  return recordPair(emptyDesktopStore(), result, new Date('2026-09-12T12:00:00Z'));
}

function memoryFiles(initial: Record<string, string> = {}) {
  const contents = new Map(Object.entries(initial));
  const files: StoreFiles = {
    read: async name => contents.get(name) ?? null,
    write: async (name, value) => { contents.set(name, value); },
    remove: async name => { contents.delete(name); }
  };
  return { files, contents };
}

function memoryVault(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const vault: TokenVault = {
    get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); }
  };
  return { vault, values };
}

describe('desktop store v2', () => {
  test('records a pair with the contract fields and without the token', () => {
    const store = paired();
    expect(store).toEqual({
      version: 2,
      lastDesktopId: desktopId,
      desktops: [{
        id: desktopId,
        name: 'Mac de Foco',
        fingerprint: '0123456789abcdef',
        deviceId,
        pairedAt: '2026-09-12T12:00:00.000Z',
        lastSeenAt: '2026-09-12T12:00:00.000Z',
        lastTransport: 'direct'
      }]
    });
    expect(JSON.stringify(store)).not.toContain('cdt1');
  });

  test('pairs the same desktop again while preserving its original pair time', () => {
    const second = recordPair(paired(), {
      ...result,
      deviceId: 'dev_BBBBBBBBBBBBBBBBBBBBBB',
      desktop: { ...result.desktop, name: '  Mac novo  ' },
      transport: 'tor'
    }, new Date('2026-09-13T12:00:00Z'));
    expect(second.desktops).toHaveLength(1);
    expect(second.desktops[0]).toMatchObject({
      name: 'Mac novo',
      deviceId: 'dev_BBBBBBBBBBBBBBBBBBBBBB',
      pairedAt: '2026-09-12T12:00:00.000Z',
      lastSeenAt: '2026-09-13T12:00:00.000Z',
      lastTransport: 'tor'
    });
  });

  test('rejects a pair result whose desktop identity does not match', () => {
    expect(() => recordPair(emptyDesktopStore(), { ...result, desktopId: otherDesktopId })).toThrow('pair_result_invalid');
    expect(() => recordPair(emptyDesktopStore(), {
      ...result,
      desktop: { ...result.desktop, fingerprint: 'not a fingerprint' }
    })).toThrow('desktop_store_invalid');
  });

  test('parses a valid store and round trips it', () => {
    expect(parseDesktopStore(JSON.stringify(paired()))).toEqual(paired());
    expect(parseDesktopStore(JSON.stringify(emptyDesktopStore()))).toEqual(emptyDesktopStore());
  });

  test.each([
    ['not json', 'desktop_store_corrupt'],
    ['[]', 'desktop_store_invalid'],
    [JSON.stringify({ profiles: [], lastProfileId: null, lastDesktopId: null }), 'desktop_store_version'],
    [JSON.stringify({ version: 3, desktops: [], lastDesktopId: null }), 'desktop_store_version'],
    [JSON.stringify({ version: 2, desktops: [], lastDesktopId: null, extra: true }), 'desktop_store_invalid'],
    [JSON.stringify({ version: 2, desktops: {}, lastDesktopId: null }), 'desktop_store_invalid'],
    [JSON.stringify({ version: 2, desktops: [], lastDesktopId: desktopId }), 'desktop_store_invalid']
  ])('rejects an invalid store document %#', (raw, error) => {
    expect(() => parseDesktopStore(raw)).toThrow(error);
  });

  test.each([
    ['id', '../secret'],
    ['name', ''],
    ['name', ' Mac '],
    ['name', 'M'.repeat(49)],
    ['name', 'Mac\nde Foco'],
    ['fingerprint', 'ABCDEF0123456789'],
    ['deviceId', 'device'],
    ['pairedAt', 'ontem'],
    ['lastSeenAt', '2026-02-31'],
    ['lastTransport', 'relay'],
    ['publicKey', 'base64url']
  ])('rejects a desktop entry with an invalid %s', (field, value) => {
    const store = paired() as unknown as { desktops: Record<string, unknown>[] };
    store.desktops[0]![field] = value;
    expect(() => parseDesktopStore(JSON.stringify(store))).toThrow('desktop_store_invalid');
  });

  test('rejects duplicate desktops', () => {
    const store = paired();
    store.desktops.push({ ...store.desktops[0]! });
    expect(() => parseDesktopStore(JSON.stringify(store))).toThrow('desktop_store_duplicate');
  });

  test('marks use with the transport and selects the desktop', () => {
    const second = recordPair(paired(), { ...result, desktopId: otherDesktopId,
      desktop: { ...result.desktop, id: otherDesktopId } }, new Date('2026-09-12T13:00:00Z'));
    const used = markDesktopUsed(second, desktopId, 'tor', new Date('2026-09-14T12:00:00Z'));
    expect(used.lastDesktopId).toBe(desktopId);
    expect(findDesktop(used, desktopId)).toMatchObject({ lastSeenAt: '2026-09-14T12:00:00.000Z', lastTransport: 'tor' });
    expect(findDesktop(used, otherDesktopId)?.lastSeenAt).toBe('2026-09-12T13:00:00.000Z');
    expect(markDesktopUsed(used, 'd_CCCCCCCCCCCCCCCCCCCCCC', 'direct')).toBe(used);
  });

  test('records a transport change without touching the last access', () => {
    const store = paired();
    expect(recordTransport(store, desktopId, 'direct')).toBe(store);
    const changed = recordTransport(store, desktopId, 'tor');
    expect(findDesktop(changed, desktopId)).toMatchObject({ lastTransport: 'tor', lastSeenAt: '2026-09-12T12:00:00.000Z' });
  });

  test('renames a desktop without changing its identity', () => {
    const renamed = renameDesktop(paired(), desktopId, '  Mac novo  ');
    expect(findDesktop(renamed, desktopId)).toMatchObject({ id: desktopId, name: 'Mac novo', fingerprint: '0123456789abcdef' });
    expect(renameDesktop(renamed, desktopId, '   ')).toBe(renamed);
    expect(cleanDesktopName('ç'.repeat(60))).toHaveLength(48);
  });

  test('removes a desktop and moves the selection to the next one', () => {
    const second = recordPair(paired(), { ...result, desktopId: otherDesktopId,
      desktop: { ...result.desktop, id: otherDesktopId } });
    const removed = removeDesktop(second, otherDesktopId);
    expect(removed.desktops.map(desktop => desktop.id)).toEqual([desktopId]);
    expect(removed.lastDesktopId).toBe(desktopId);
    const empty = removeDesktop(removed, desktopId);
    expect(empty).toEqual(emptyDesktopStore());
  });

  test('loads nothing on a fresh install', async () => {
    const { files } = memoryFiles();
    await expect(loadDesktopStore(files, memoryVault().vault)).resolves.toEqual({
      store: emptyDesktopStore(), legacyDiscarded: false
    });
  });

  test('saves and loads the store file', async () => {
    const { files, contents } = memoryFiles();
    await saveDesktopStore(paired(), files);
    expect(contents.get(STORE_FILE)).toBe(`${JSON.stringify(paired(), null, 2)}\n`);
    await expect(loadDesktopStore(files, memoryVault().vault)).resolves.toEqual({ store: paired(), legacyDiscarded: false });
  });

  test('refuses to save an invalid store', async () => {
    const { files, contents } = memoryFiles();
    const invalid = { ...paired(), lastDesktopId: otherDesktopId };
    await expect(saveDesktopStore(invalid, files)).rejects.toThrow('desktop_store_invalid');
    expect(contents.has(STORE_FILE)).toBe(false);
  });

  test('surfaces a corrupt store instead of silently dropping desktops', async () => {
    const { files } = memoryFiles({ [STORE_FILE]: '{"version":2' });
    await expect(loadDesktopStore(files, memoryVault().vault)).rejects.toThrow('desktop_store_corrupt');
  });

  test('discards Headscale profiles once and deletes their known tokens', async () => {
    const legacyId = 'd_LLLLLLLLLLLLLLLLLLLLLL';
    const legacy = JSON.stringify({
      profiles: [
        { id: 'profile_1', controlUrl: 'https://hs.example.com', userId: '42', userName: 'foco', lastUsedAt: '',
          desktops: [{ id: legacyId, name: 'Mac', port: 4740, nodeKey: 'nodekey:x', deviceId, pairedAt: '', lastSeenAt: '' },
            { id: '../escape' }] },
        { id: 'profile_2', desktops: 'broken' }
      ],
      lastProfileId: 'profile_1',
      lastDesktopId: legacyId
    });
    const { files, contents } = memoryFiles({ [LEGACY_STORE_FILE]: legacy });
    const { vault, values } = memoryVault({
      [`cialai.device.${legacyId}`]: 'cdt1.old',
      'cialai.language': 'pt-BR'
    });

    await expect(loadDesktopStore(files, vault)).resolves.toEqual({ store: emptyDesktopStore(), legacyDiscarded: true });
    expect(contents.has(LEGACY_STORE_FILE)).toBe(false);
    expect([...values.keys()]).toEqual(['cialai.language']);

    await expect(loadDesktopStore(files, vault)).resolves.toEqual({ store: emptyDesktopStore(), legacyDiscarded: false });
  });

  test('discards a leftover legacy file next to an existing v2 store', async () => {
    const { files, contents } = memoryFiles({ [LEGACY_STORE_FILE]: 'not json', [STORE_FILE]: JSON.stringify(paired()) });
    await expect(loadDesktopStore(files, memoryVault().vault)).resolves.toEqual({ store: paired(), legacyDiscarded: true });
    expect(contents.has(LEGACY_STORE_FILE)).toBe(false);
  });

  test('reads legacy desktop ids defensively', () => {
    expect(legacyDesktopIds('not json')).toEqual([]);
    expect(legacyDesktopIds('{"profiles":{}}')).toEqual([]);
    expect(legacyDesktopIds(JSON.stringify({ profiles: [{ desktops: [{ id: 'd_1234567890abcdef' }, { id: 7 }] }] })))
      .toEqual(['d_1234567890abcdef']);
  });

  test('stores each device token under its desktop key', async () => {
    const { vault, values } = memoryVault();
    await saveDeviceToken(desktopId, token, vault);
    expect(values.get(`cialai.device.${desktopId}`)).toBe(token);
    await expect(readDeviceToken(desktopId, vault)).resolves.toBe(token);
    await deleteDeviceToken(desktopId, vault);
    await expect(readDeviceToken(desktopId, vault)).resolves.toBeNull();
  });

  test('rejects unsafe token keys and malformed tokens', async () => {
    const { vault } = memoryVault();
    await expect(readDeviceToken('../secret', vault)).rejects.toThrow('desktop_id_invalid');
    await expect(saveDeviceToken(desktopId, 'cdt1.short', vault)).rejects.toThrow('desktop_token_invalid');
  });

  test('uses the strongest portable keychain accessibility', async () => {
    const set = jest.spyOn(SecureStore, 'setItemAsync').mockResolvedValue();
    await saveDeviceToken(desktopId, token, secureVault);
    expect(set).toHaveBeenCalledWith(`cialai.device.${desktopId}`, token,
      expect.objectContaining({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }));
    set.mockRestore();
  });
});
