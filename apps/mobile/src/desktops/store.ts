import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

import type { PairResult, Transport } from 'cialai-tunnel';

export type LastTransport = Transport | '';

export type DesktopEntry = {
  id: string;
  name: string;
  fingerprint: string;
  deviceId: string;
  pairedAt: string;
  lastSeenAt: string;
  lastTransport: LastTransport;
};

export type DesktopStore = {
  version: 2;
  desktops: DesktopEntry[];
  lastDesktopId: string | null;
};

export type LoadedDesktopStore = {
  store: DesktopStore;
  // Verdadeiro uma vez, quando os perfis do Headscale foram apagados nesta abertura.
  legacyDiscarded: boolean;
};

// Armazenamento de texto e cofre de tokens separados para os testes trocarem a plataforma.
export type StoreFiles = {
  read(name: string): Promise<string | null>;
  write(name: string, contents: string): Promise<void>;
  remove(name: string): Promise<void>;
};

export type TokenVault = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export const STORE_FILE = 'desktops.json';
export const LEGACY_STORE_FILE = 'profiles.json';
export const MAX_DESKTOP_NAME = 48;

const TOKEN_PREFIX = 'cialai.device.';
const DESKTOP_ID = /^d_[A-Za-z0-9_-]{22}$/;
// Os perfis antigos aceitavam ids de 16 a 32 caracteres; a limpeza respeita essa faixa.
const TOKEN_DESKTOP_ID = /^d_[A-Za-z0-9_-]{16,32}$/;
const DEVICE_ID = /^dev_[A-Za-z0-9_-]{22}$/;
// `identity.Fingerprint` tem 16 hexadecimais; a faixa maior tolera um resumo mais longo.
const FINGERPRINT = /^[0-9a-f]{16,64}$/;
const DEVICE_TOKEN = /^cdt1\.dev_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const STORE_KEYS = ['desktops', 'lastDesktopId', 'version'];
const ENTRY_KEYS = ['deviceId', 'fingerprint', 'id', 'lastSeenAt', 'lastTransport', 'name', 'pairedAt'];
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
};

export const emptyDesktopStore = (): DesktopStore => ({ version: 2, desktops: [], lastDesktopId: null });

function storeDirectory(): Directory {
  const directory = new Directory(Paths.document, 'cialai');
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

export const deviceFiles: StoreFiles = {
  async read(name) {
    const file = new File(storeDirectory(), name);
    return file.exists ? file.text() : null;
  },
  async write(name, contents) {
    new File(storeDirectory(), name).write(contents);
  },
  async remove(name) {
    const file = new File(storeDirectory(), name);
    if (file.exists) file.delete();
  }
};

export const secureVault: TokenVault = {
  get: key => SecureStore.getItemAsync(key, SECURE_OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(key, value, SECURE_OPTIONS),
  remove: key => SecureStore.deleteItemAsync(key, SECURE_OPTIONS)
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('|') === keys.join('|');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

export function isDesktopId(value: unknown): value is string {
  return typeof value === 'string' && DESKTOP_ID.test(value);
}

// Mesmo limite do núcleo: até 48 caracteres, sem caracteres de controle.
export function cleanDesktopName(value: string): string {
  const printable = [...value].filter(character => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  }).join('').trim();
  return [...printable].slice(0, MAX_DESKTOP_NAME).join('').trim();
}

function isDesktopName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && cleanDesktopName(value) === value;
}

function validateEntry(value: unknown): DesktopEntry {
  if (!isRecord(value) || !hasExactKeys(value, ENTRY_KEYS) || !isDesktopId(value.id) ||
      !isDesktopName(value.name) || typeof value.fingerprint !== 'string' || !FINGERPRINT.test(value.fingerprint) ||
      typeof value.deviceId !== 'string' || !DEVICE_ID.test(value.deviceId) ||
      !isTimestamp(value.pairedAt) || !isTimestamp(value.lastSeenAt) ||
      (value.lastTransport !== 'direct' && value.lastTransport !== 'tor' && value.lastTransport !== '')) {
    throw new Error('desktop_store_invalid');
  }
  return {
    id: value.id,
    name: value.name,
    fingerprint: value.fingerprint,
    deviceId: value.deviceId,
    pairedAt: value.pairedAt,
    lastSeenAt: value.lastSeenAt,
    lastTransport: value.lastTransport
  };
}

export function validateDesktopStore(value: unknown): DesktopStore {
  if (!isRecord(value)) throw new Error('desktop_store_invalid');
  if (value.version !== 2) throw new Error('desktop_store_version');
  if (!hasExactKeys(value, STORE_KEYS) || !Array.isArray(value.desktops) ||
      (value.lastDesktopId !== null && !isDesktopId(value.lastDesktopId))) {
    throw new Error('desktop_store_invalid');
  }
  const desktops = value.desktops.map(validateEntry);
  const ids = new Set(desktops.map(desktop => desktop.id));
  if (ids.size !== desktops.length) throw new Error('desktop_store_duplicate');
  if (value.lastDesktopId !== null && !ids.has(value.lastDesktopId)) throw new Error('desktop_store_invalid');
  return { version: 2, desktops, lastDesktopId: value.lastDesktopId };
}

export function parseDesktopStore(raw: string): DesktopStore {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('desktop_store_corrupt');
  }
  return validateDesktopStore(value);
}

// Ids dos computadores dos perfis do Headscale, lidos sem exigir o formato antigo inteiro.
export function legacyDesktopIds(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value.profiles)) return [];
  const ids = new Set<string>();
  for (const profile of value.profiles) {
    if (!isRecord(profile) || !Array.isArray(profile.desktops)) continue;
    for (const desktop of profile.desktops) {
      if (isRecord(desktop) && typeof desktop.id === 'string' && TOKEN_DESKTOP_ID.test(desktop.id)) ids.add(desktop.id);
    }
  }
  return [...ids];
}

async function discardLegacyProfiles(files: StoreFiles, vault: TokenVault): Promise<boolean> {
  const legacy = await files.read(LEGACY_STORE_FILE);
  if (legacy === null) return false;
  for (const desktopId of legacyDesktopIds(legacy)) {
    await vault.remove(tokenKey(desktopId)).catch(() => undefined);
  }
  await files.remove(LEGACY_STORE_FILE);
  return true;
}

export async function loadDesktopStore(
  files: StoreFiles = deviceFiles,
  vault: TokenVault = secureVault
): Promise<LoadedDesktopStore> {
  const legacyDiscarded = await discardLegacyProfiles(files, vault);
  const raw = await files.read(STORE_FILE);
  return { store: raw === null ? emptyDesktopStore() : parseDesktopStore(raw), legacyDiscarded };
}

export async function saveDesktopStore(store: DesktopStore, files: StoreFiles = deviceFiles): Promise<void> {
  const valid = validateDesktopStore(store);
  await files.write(STORE_FILE, `${JSON.stringify(valid, null, 2)}\n`);
}

export function findDesktop(store: DesktopStore, desktopId: string | null | undefined): DesktopEntry | null {
  return store.desktops.find(desktop => desktop.id === desktopId) ?? null;
}

export function recordPair(store: DesktopStore, result: PairResult, now = new Date()): DesktopStore {
  if (result.desktopId !== result.desktop.id) throw new Error('pair_result_invalid');
  const timestamp = now.toISOString();
  const current = findDesktop(store, result.desktopId);
  const entry = validateEntry({
    id: result.desktopId,
    name: cleanDesktopName(result.desktop.name),
    fingerprint: result.desktop.fingerprint.toLowerCase(),
    deviceId: result.deviceId,
    pairedAt: current?.pairedAt ?? timestamp,
    lastSeenAt: timestamp,
    lastTransport: result.transport
  });
  const desktops = current
    ? store.desktops.map(desktop => desktop.id === entry.id ? entry : desktop)
    : [...store.desktops, entry];
  return { version: 2, desktops, lastDesktopId: entry.id };
}

export function markDesktopUsed(
  store: DesktopStore,
  desktopId: string,
  transport: Transport,
  now = new Date()
): DesktopStore {
  if (!findDesktop(store, desktopId)) return store;
  const timestamp = now.toISOString();
  return {
    version: 2,
    desktops: store.desktops.map(desktop => desktop.id === desktopId
      ? { ...desktop, lastSeenAt: timestamp, lastTransport: transport }
      : desktop),
    lastDesktopId: desktopId
  };
}

export function recordTransport(store: DesktopStore, desktopId: string, transport: Transport): DesktopStore {
  const current = findDesktop(store, desktopId);
  if (!current || current.lastTransport === transport) return store;
  return {
    ...store,
    desktops: store.desktops.map(desktop => desktop.id === desktopId ? { ...desktop, lastTransport: transport } : desktop)
  };
}

export function renameDesktop(store: DesktopStore, desktopId: string, name: string): DesktopStore {
  const clean = cleanDesktopName(name);
  if (!clean || !findDesktop(store, desktopId)) return store;
  return {
    ...store,
    desktops: store.desktops.map(desktop => desktop.id === desktopId ? { ...desktop, name: clean } : desktop)
  };
}

export function removeDesktop(store: DesktopStore, desktopId: string): DesktopStore {
  const desktops = store.desktops.filter(desktop => desktop.id !== desktopId);
  const lastDesktopId = store.lastDesktopId === desktopId ? desktops[0]?.id ?? null : store.lastDesktopId;
  return { version: 2, desktops, lastDesktopId };
}

export function tokenKey(desktopId: string): string {
  if (!TOKEN_DESKTOP_ID.test(desktopId)) throw new Error('desktop_id_invalid');
  return TOKEN_PREFIX + desktopId;
}

export async function readDeviceToken(desktopId: string, vault: TokenVault = secureVault): Promise<string | null> {
  return vault.get(tokenKey(desktopId));
}

export async function saveDeviceToken(desktopId: string, token: string, vault: TokenVault = secureVault): Promise<void> {
  if (!DEVICE_TOKEN.test(token)) throw new Error('desktop_token_invalid');
  await vault.set(tokenKey(desktopId), token);
}

export async function deleteDeviceToken(desktopId: string, vault: TokenVault = secureVault): Promise<void> {
  await vault.remove(tokenKey(desktopId));
}
