import AsyncStorage from '@react-native-async-storage/async-storage';
import { ServerInfo } from './types';

const KEY = 'remcontrol:last-connection';

export async function saveLastConnection(info: ServerInfo): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(info));
}

export async function loadLastConnection(): Promise<ServerInfo | null> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ServerInfo).ip === 'string' &&
      typeof (parsed as ServerInfo).port === 'number' &&
      typeof (parsed as ServerInfo).token === 'string'
    ) {
      return parsed as ServerInfo;
    }
  } catch {
    // corrupted entry, treat as absent
  }
  return null;
}
