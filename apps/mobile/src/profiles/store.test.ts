import * as SecureStore from 'expo-secure-store';

import {
  emptyProfileStore,
  markDesktopUsed,
  parseProfileStore,
  readDeviceToken,
  recordPair,
  removeDesktop,
  removeProfile,
  renameDesktop,
  saveDeviceToken,
  type ProfileStore
} from './store';

const desktopId = 'd_AAAAAAAAAAAAAAAAAAAAAA';
const profileId = 'profile_AAAAAAAAAAAAAAAAAAAAAA';
const inspection = {
  v: 1 as const,
  control: 'https://hs.example.com',
  userId: '42',
  userName: 'foco',
  desktop: { id: desktopId, name: 'Mac de Foco', port: 4740 },
  expiresAt: 1_800_000_000,
  hasAuthKey: true,
  profileMatch: 'new' as const
};
const result = {
  profileId,
  desktopId,
  deviceId: 'dev_AAAAAAAAAAAAAAAAAAAAAA',
  token: 'cdt1.dev_AAAAAAAAAAAAAAAAAAAAAA.secret',
  desktop: { id: desktopId, name: 'Mac de Foco', port: 4740,
    nodeKey: `nodekey:${'a'.repeat(64)}` },
  nodeKey: `nodekey:${'b'.repeat(64)}`
};

function paired(): ProfileStore {
  return recordPair(emptyProfileStore(), inspection, result, new Date('2026-09-12T12:00:00Z'));
}

describe('profile store', () => {
  test('records a pair without persisting its token', () => {
    const store = paired();
    expect(store.lastProfileId).toBe(profileId);
    expect(store.lastDesktopId).toBe(desktopId);
    expect(JSON.stringify(store)).not.toContain('cdt1');
    expect(store.profiles[0]?.desktops[0]?.nodeKey).toBe(result.desktop.nodeKey);
  });

  test('repairs the same desktop while preserving its original pair time', () => {
    const first = paired();
    const second = recordPair(first, { ...inspection, profileMatch: 'existing' },
      { ...result, deviceId: 'dev_BBBBBBBBBBBBBBBBBBBBBB' }, new Date('2026-09-13T12:00:00Z'));
    expect(second.profiles).toHaveLength(1);
    expect(second.profiles[0]?.desktops).toHaveLength(1);
    expect(second.profiles[0]?.desktops[0]?.pairedAt).toBe('2026-09-12T12:00:00.000Z');
    expect(second.profiles[0]?.desktops[0]?.deviceId).toBe('dev_BBBBBBBBBBBBBBBBBBBBBB');
  });

  test('parses valid profiles and rejects corrupt or duplicate data', () => {
    const raw = JSON.stringify(paired());
    expect(parseProfileStore(raw)).toEqual(paired());
    expect(() => parseProfileStore('not json')).toThrow('corrompidos');
    const duplicate = paired();
    duplicate.profiles.push(duplicate.profiles[0]!);
    expect(() => parseProfileStore(JSON.stringify(duplicate))).toThrow('duplicados');
  });

  test('marks use and renames a desktop without changing identity', () => {
    const used = markDesktopUsed(paired(), profileId, desktopId, new Date('2026-09-14T12:00:00Z'));
    const renamed = renameDesktop(used, desktopId, '  Mac novo  ');
    expect(renamed.profiles[0]?.desktops[0]?.name).toBe('Mac novo');
    expect(renamed.profiles[0]?.desktops[0]?.id).toBe(desktopId);
    expect(renamed.profiles[0]?.lastUsedAt).toBe('2026-09-14T12:00:00.000Z');
  });

  test('removes a desktop and clears only its selection', () => {
    const removed = removeDesktop(paired(), profileId, desktopId);
    expect(removed.profiles[0]?.desktops).toEqual([]);
    expect(removed.lastDesktopId).toBeNull();
    expect(removed.lastProfileId).toBe(profileId);
  });

  test('removes a profile and selects the next available profile', () => {
    const first = paired();
    const second = { ...first.profiles[0]!, id: 'profile_BBBBBBBBBBBBBBBBBBBBBB', userId: '43', desktops: [] };
    const removed = removeProfile({ ...first, profiles: [...first.profiles, second] }, profileId);
    expect(removed.profiles.map(profile => profile.id)).toEqual([second.id]);
    expect(removed.lastProfileId).toBe(second.id);
  });

  test('stores each device token with the strongest portable accessibility', async () => {
    const set = jest.spyOn(SecureStore, 'setItemAsync').mockResolvedValue();
    await saveDeviceToken(desktopId, result.token);
    expect(set).toHaveBeenCalledWith(`cialai.device.${desktopId}`, result.token,
      expect.objectContaining({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }));
    set.mockRestore();
  });

  test('reads only a validated desktop token key', async () => {
    const get = jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(result.token);
    await expect(readDeviceToken(desktopId)).resolves.toBe(result.token);
    expect(() => readDeviceToken('../secret')).toThrow('inválido');
    get.mockRestore();
  });
});
