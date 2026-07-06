import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { ServerInfo } from './types';

const RECENT_KEY = 'remcontrol:recent-connections';
const LAST_KEY = 'remcontrol:last-connection';
const LEGACY_LAST_KEY = 'remcontrol:last-connection';
const MAX_RECENT = 5;
const SECURE_KEYCHAIN = 'remcontrol-token';

function sameServer(a: ServerInfo, b: ServerInfo): boolean {
  return a.ip === b.ip && a.port === b.port;
}

/// SecureStore key for a server's token, keyed by ip+port. Expo SecureStore
/// rejects keys containing ":" (only alphanumeric, ".", "-", "_" are allowed),
/// so join with "-" instead of ":". The IP's dotted octets use only "." and
/// digits, so `ip-port` is unambiguous.
function tokenKey(ip: string, port: number): string {
  return `${ip}-${port}`;
}

function publicInfo(info: ServerInfo): Omit<ServerInfo, 'token'> {
  return { ip: info.ip, port: info.port, name: info.name };
}

async function saveToken(info: ServerInfo): Promise<void> {
  await SecureStore.setItemAsync(tokenKey(info.ip, info.port), info.token, {
    keychainService: SECURE_KEYCHAIN,
  });
}

async function loadToken(ip: string, port: number): Promise<string | null> {
  return SecureStore.getItemAsync(tokenKey(ip, port), {
    keychainService: SECURE_KEYCHAIN,
  });
}

async function deleteToken(ip: string, port: number): Promise<void> {
  await SecureStore.deleteItemAsync(tokenKey(ip, port), {
    keychainService: SECURE_KEYCHAIN,
  });
}

export async function saveConnection(info: ServerInfo): Promise<ServerInfo[]> {
  await saveToken(info);
  await AsyncStorage.setItem(LAST_KEY, JSON.stringify(publicInfo(info)));
  const recent = await loadRecentConnections();
  const merged = [info, ...recent.filter((r) => !sameServer(r, info))].slice(0, MAX_RECENT);
  await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(merged.map((r) => publicInfo(r))));
  return merged;
}

export async function loadRecentConnections(): Promise<ServerInfo[]> {
  const raw = await AsyncStorage.getItem(RECENT_KEY);
  if (!raw) {
    return migrateLegacy();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ServerInfo[] = [];
  for (const entry of parsed) {
    if (!isServerInfo(entry)) continue;
    const token = await loadToken(entry.ip, entry.port);
    if (!token) continue;
    out.push({ ...entry, name: entry.name?.trim() || undefined, token });
  }
  return out;
}

export async function loadLastConnection(): Promise<ServerInfo | null> {
  const raw = await AsyncStorage.getItem(LAST_KEY);
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (isServerInfo(parsed)) {
      const token = await loadToken(parsed.ip, parsed.port);
      if (token) {
        return { ...parsed, name: parsed.name?.trim() || undefined, token };
      }
    }
  }
  // Legacy: the old format stored the full ServerInfo (with token) inline.
  return migrateLegacyLast();
}

export async function forgetConnection(target: ServerInfo): Promise<ServerInfo[]> {
  await deleteToken(target.ip, target.port);
  const recent = await loadRecentConnections();
  const next = recent.filter((r) => !sameServer(r, target));
  await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next.map((r) => publicInfo(r))));
  return next;
}

/** One-time migration of the old single-blob AsyncStorage format to the
 * split (SecureStore token) format. Returns the migrated list so the first
 * launch after upgrade still populates the Recent tab. */
async function migrateLegacy(): Promise<ServerInfo[]> {
  const raw = await AsyncStorage.getItem(LEGACY_LAST_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isServerInfo(parsed) || !parsed.token) return [];
  await saveToken(parsed);
  await AsyncStorage.setItem(LAST_KEY, JSON.stringify(publicInfo(parsed)));
  return [parsed];
}

async function migrateLegacyLast(): Promise<ServerInfo | null> {
  const migrated = await migrateLegacy();
  return migrated[0] ?? null;
}

function isServerInfo(value: unknown): value is ServerInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ip === 'string' &&
    typeof v.port === 'number' &&
    (v.token === undefined || typeof v.token === 'string') &&
    (v.name === undefined || typeof v.name === 'string')
  );
}
