import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
    clear: async () => {
      store.clear();
    },
  },
}));

import { DEFAULT_PREFS, loadPrefs, savePrefs } from './prefs';

describe('loadPrefs / savePrefs', () => {
  beforeEach(() => {
    store.clear();
  });

  it('returns defaults when nothing is stored', async () => {
    expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('round-trips a full prefs object', async () => {
    const custom = {
      defaultSensitivity: 2.5,
      autoReconnect: false,
      recentRefreshIntervalSec: 30,
      fabPosition: { x: 120, y: 540 },
      floatingKeyboard: true,
    };
    await savePrefs(custom);
    expect(await loadPrefs()).toEqual(custom);
  });

  it('persists a null fabPosition', async () => {
    const custom = {
      defaultSensitivity: 1.5,
      autoReconnect: true,
      recentRefreshIntervalSec: 10,
      fabPosition: null,
      floatingKeyboard: false,
    };
    await savePrefs(custom);
    expect(await loadPrefs()).toEqual(custom);
  });

  it('falls back to defaults on corrupted json', async () => {
    store.set('remcontrol:prefs', '{not json');
    expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('falls back to defaults when storage is not an object', async () => {
    store.set('remcontrol:prefs', JSON.stringify('oops'));
    expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('fills missing fields with defaults, keeps valid ones', async () => {
    store.set('remcontrol:prefs', JSON.stringify({ autoReconnect: false }));
    const p = await loadPrefs();
    expect(p.defaultSensitivity).toBe(DEFAULT_PREFS.defaultSensitivity);
    expect(p.autoReconnect).toBe(false);
    expect(p.recentRefreshIntervalSec).toBe(DEFAULT_PREFS.recentRefreshIntervalSec);
  });

  it('ignores fields of the wrong type', async () => {
    store.set(
      'remcontrol:prefs',
      JSON.stringify({
        defaultSensitivity: 'fast',
        autoReconnect: 1,
        recentRefreshIntervalSec: 'off',
      }),
    );
    expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
  });
});
