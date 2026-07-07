import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFS_KEY = 'remcontrol:prefs';

export interface Prefs {
  /** Initial pointer speed used when opening the trackpad. */
  defaultSensitivity: number;
  /** On launch, silently reconnect to the last successful server. */
  autoReconnect: boolean;
  /** Seconds between reachability re-probes on the Recent tab. 0 disables. */
  recentRefreshIntervalSec: number;
  /** Last position of the floating keyboard button, in px from top-left. */
  fabPosition: { x: number; y: number } | null;
  /** Whether the keyboard button is a floating FAB (true) or docked in the top bar. */
  floatingKeyboard: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  defaultSensitivity: 1.5,
  autoReconnect: true,
  recentRefreshIntervalSec: 10,
  fabPosition: null,
  floatingKeyboard: true,
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
    recentRefreshIntervalSec:
      typeof p.recentRefreshIntervalSec === 'number'
        ? p.recentRefreshIntervalSec
        : DEFAULT_PREFS.recentRefreshIntervalSec,
    fabPosition: isPoint(p.fabPosition) ? p.fabPosition : DEFAULT_PREFS.fabPosition,
    floatingKeyboard:
      typeof p.floatingKeyboard === 'boolean' ? p.floatingKeyboard : DEFAULT_PREFS.floatingKeyboard,
  };
}

function isPoint(v: unknown): v is { x: number; y: number } {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.x === 'number' && typeof o.y === 'number';
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
