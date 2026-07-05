import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ServerInfo } from './types';

const RECENT_KEY = 'remcontrol:recent-connections';
const LAST_KEY = 'remcontrol:last-connection';
const MAX_RECENT = 5;

function sameServer(a: ServerInfo, b: ServerInfo): boolean {
  return a.ip === b.ip && a.port === b.port;
}

export async function saveConnection(info: ServerInfo): Promise<ServerInfo[]> {
  await AsyncStorage.setItem(LAST_KEY, JSON.stringify(info));
  const recent = await loadRecentConnections();
  const merged = [info, ...recent.filter((r) => !sameServer(r, info))].slice(0, MAX_RECENT);
  await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(merged));
  return merged;
}

export async function loadRecentConnections(): Promise<ServerInfo[]> {
  const raw = await AsyncStorage.getItem(RECENT_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isServerInfo)
      .map((info) => ({ ...info, name: info.name?.trim() || undefined }));
  } catch {
    return [];
  }
}

export async function loadLastConnection(): Promise<ServerInfo | null> {
  const raw = await AsyncStorage.getItem(LAST_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isServerInfo(parsed)) return null;
    return { ...parsed, name: parsed.name?.trim() || undefined };
  } catch {
    return null;
  }
}

export async function forgetConnection(target: ServerInfo): Promise<ServerInfo[]> {
  const recent = await loadRecentConnections();
  const next = recent.filter((r) => !sameServer(r, target));
  await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next));
  return next;
}

function isServerInfo(value: unknown): value is ServerInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ip === 'string' &&
    typeof v.port === 'number' &&
    typeof v.token === 'string' &&
    (v.name === undefined || typeof v.name === 'string')
  );
}
