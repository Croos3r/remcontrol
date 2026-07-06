import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFS_KEY = 'remcontrol:prefs';

export interface Prefs {
  /** Initial pointer speed used when opening the trackpad. */
  defaultSensitivity: number;
  /** On launch, silently reconnect to the last successful server. */
  autoReconnect: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  defaultSensitivity: 1.5,
  autoReconnect: true,
};

export async function loadPrefs(): Promise<Prefs> {
  const raw = await AsyncStorage.getItem(PREFS_KEY);
  if (!raw) return { ...DEFAULT_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_PREFS };
  const p = parsed as Partial<Record<keyof Prefs, unknown>>;
  return {
    defaultSensitivity:
      typeof p.defaultSensitivity === 'number'
        ? p.defaultSensitivity
        : DEFAULT_PREFS.defaultSensitivity,
    autoReconnect:
      typeof p.autoReconnect === 'boolean' ? p.autoReconnect : DEFAULT_PREFS.autoReconnect,
  };
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
