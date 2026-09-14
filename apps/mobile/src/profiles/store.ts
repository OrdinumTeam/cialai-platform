import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

import type { PairInspection, PairResult } from 'cialai-tunnel';

export type DesktopProfile = {
  id: string;
  name: string;
  port: number;
  nodeKey: string;
  deviceId: string;
  pairedAt: string;
  lastSeenAt: string;
};

export type HeadscaleProfile = {
  id: string;
  controlUrl: string;
  userId: string;
  userName: string;
  lastUsedAt: string;
  desktops: DesktopProfile[];
};

export type ProfileStore = {
  profiles: HeadscaleProfile[];
  lastProfileId: string | null;
  lastDesktopId: string | null;
};

const TOKEN_PREFIX = 'cialai.device.';
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
};

export const emptyProfileStore = (): ProfileStore => ({
  profiles: [],
  lastProfileId: null,
  lastDesktopId: null
});

function profilesFile(): File {
  const directory = new Directory(Paths.document, 'cialai');
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, 'profiles.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateDesktop(value: unknown): DesktopProfile {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
      typeof value.port !== 'number' || typeof value.nodeKey !== 'string' ||
      typeof value.deviceId !== 'string' || typeof value.pairedAt !== 'string' ||
      typeof value.lastSeenAt !== 'string') throw new Error('desktop_profile_invalid');
  return value as DesktopProfile;
}

function validateProfile(value: unknown): HeadscaleProfile {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.controlUrl !== 'string' ||
      typeof value.userId !== 'string' || typeof value.userName !== 'string' ||
      typeof value.lastUsedAt !== 'string' || !Array.isArray(value.desktops)) {
    throw new Error('server_profile_invalid');
  }
  return { ...value, desktops: value.desktops.map(validateDesktop) } as HeadscaleProfile;
}

export function parseProfileStore(raw: string): ProfileStore {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('profile_store_corrupt');
  }
  if (!isRecord(value) || !Array.isArray(value.profiles) ||
      (value.lastProfileId !== null && typeof value.lastProfileId !== 'string') ||
      (value.lastDesktopId !== null && typeof value.lastDesktopId !== 'string')) {
    throw new Error('profile_store_invalid');
  }
  const profiles = value.profiles.map(validateProfile);
  const ids = new Set<string>();
  const desktopIds = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error('profile_store_duplicate_profiles');
    ids.add(profile.id);
    for (const desktop of profile.desktops) {
      if (desktopIds.has(desktop.id)) throw new Error('profile_store_duplicate_desktops');
      desktopIds.add(desktop.id);
    }
  }
  return { profiles, lastProfileId: value.lastProfileId, lastDesktopId: value.lastDesktopId };
}

export async function loadProfileStore(): Promise<ProfileStore> {
  const file = profilesFile();
  if (!file.exists) return emptyProfileStore();
  return parseProfileStore(await file.text());
}

export async function saveProfileStore(store: ProfileStore): Promise<void> {
  const file = profilesFile();
  file.write(`${JSON.stringify(store, null, 2)}\n`);
}

export function recordPair(
  store: ProfileStore,
  inspection: PairInspection,
  result: PairResult,
  now = new Date()
): ProfileStore {
  const timestamp = now.toISOString();
  const desktop: DesktopProfile = {
    id: result.desktopId,
    name: result.desktop.name,
    port: result.desktop.port,
    nodeKey: result.desktop.nodeKey,
    deviceId: result.deviceId,
    pairedAt: timestamp,
    lastSeenAt: timestamp
  };
  const profiles = [...store.profiles];
  const index = profiles.findIndex(profile => profile.id === result.profileId);
  if (index >= 0) {
    const current = profiles[index]!;
    const desktopIndex = current.desktops.findIndex(candidate => candidate.id === desktop.id);
    const desktops = [...current.desktops];
    if (desktopIndex >= 0) desktops[desktopIndex] = { ...desktop, pairedAt: desktops[desktopIndex]!.pairedAt };
    else desktops.push(desktop);
    profiles[index] = { ...current, lastUsedAt: timestamp, desktops };
  } else {
    profiles.push({
      id: result.profileId,
      controlUrl: inspection.control,
      userId: inspection.userId,
      userName: inspection.userName,
      lastUsedAt: timestamp,
      desktops: [desktop]
    });
  }
  return { profiles, lastProfileId: result.profileId, lastDesktopId: result.desktopId };
}

export function markDesktopUsed(store: ProfileStore, profileId: string, desktopId: string, now = new Date()): ProfileStore {
  const timestamp = now.toISOString();
  return {
    profiles: store.profiles.map(profile => profile.id === profileId
      ? { ...profile, lastUsedAt: timestamp, desktops: profile.desktops.map(desktop =>
          desktop.id === desktopId ? { ...desktop, lastSeenAt: timestamp } : desktop) }
      : profile),
    lastProfileId: profileId,
    lastDesktopId: desktopId
  };
}

export function renameDesktop(store: ProfileStore, desktopId: string, name: string): ProfileStore {
  const clean = name.trim().slice(0, 48);
  if (!clean) return store;
  return { ...store, profiles: store.profiles.map(profile => ({
    ...profile,
    desktops: profile.desktops.map(desktop => desktop.id === desktopId ? { ...desktop, name: clean } : desktop)
  })) };
}

export function removeDesktop(store: ProfileStore, profileId: string, desktopId: string): ProfileStore {
  const profiles = store.profiles.map(profile => profile.id === profileId
    ? { ...profile, desktops: profile.desktops.filter(desktop => desktop.id !== desktopId) }
    : profile);
  const remaining = profiles.flatMap(profile => profile.desktops);
  return {
    profiles,
    lastProfileId: store.lastProfileId,
    lastDesktopId: store.lastDesktopId === desktopId ? remaining[0]?.id ?? null : store.lastDesktopId
  };
}

export function removeProfile(store: ProfileStore, profileId: string): ProfileStore {
  const profiles = store.profiles.filter(profile => profile.id !== profileId);
  const lastProfile = profiles.find(profile => profile.id === store.lastProfileId) ?? profiles[0];
  const allDesktops = profiles.flatMap(profile => profile.desktops);
  const lastDesktop = allDesktops.find(desktop => desktop.id === store.lastDesktopId) ?? lastProfile?.desktops[0];
  return {
    profiles,
    lastProfileId: lastProfile?.id ?? null,
    lastDesktopId: lastDesktop?.id ?? null
  };
}

function tokenKey(desktopId: string): string {
  if (!/^d_[A-Za-z0-9_-]{16,32}$/.test(desktopId)) throw new Error('desktop_id_invalid');
  return TOKEN_PREFIX + desktopId;
}

export function readDeviceToken(desktopId: string): Promise<string | null> {
  return SecureStore.getItemAsync(tokenKey(desktopId), SECURE_OPTIONS);
}

export function saveDeviceToken(desktopId: string, token: string): Promise<void> {
  if (!token.startsWith('cdt1.')) throw new Error('desktop_token_invalid');
  return SecureStore.setItemAsync(tokenKey(desktopId), token, SECURE_OPTIONS);
}

export function deleteDeviceToken(desktopId: string): Promise<void> {
  return SecureStore.deleteItemAsync(tokenKey(desktopId), SECURE_OPTIONS);
}
