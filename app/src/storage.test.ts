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

import {
  forgetConnection,
  loadLastConnection,
  loadRecentConnections,
  saveConnection,
} from './storage';
import type { ServerInfo } from './types';

function server(ip: string, port = 17890, name?: string): ServerInfo {
  return { ip, port, token: 'tok', name };
}

describe('saveConnection / loadRecentConnections', () => {
  beforeEach(() => store.clear());

  it('stores and reloads a connection', async () => {
    await saveConnection(server('192.168.1.10', 17890, 'valiant'));
    expect(await loadRecentConnections()).toEqual([server('192.168.1.10', 17890, 'valiant')]);
  });

  it('dedups by ip:port and keeps the newest first', async () => {
    await saveConnection(server('192.168.1.10', 17890, 'old-name'));
    await saveConnection(server('192.168.1.20', 17890));
    await saveConnection(server('192.168.1.10', 17890, 'new-name'));

    const recent = await loadRecentConnections();
    expect(recent).toHaveLength(2);
    expect(recent[0]).toEqual(server('192.168.1.10', 17890, 'new-name'));
    expect(recent[1].ip).toBe('192.168.1.20');
  });

  it('distinguishes servers on the same ip by port', async () => {
    await saveConnection(server('192.168.1.10', 17890));
    await saveConnection(server('192.168.1.10', 17891));
    expect(await loadRecentConnections()).toHaveLength(2);
  });

  it('caps the list at 5 entries', async () => {
    for (let i = 1; i <= 7; i++) await saveConnection(server(`10.0.0.${i}`));
    const recent = await loadRecentConnections();
    expect(recent).toHaveLength(5);
    expect(recent[0].ip).toBe('10.0.0.7');
    expect(recent[4].ip).toBe('10.0.0.3');
  });

  it('normalizes a whitespace-only name to undefined', async () => {
    await saveConnection(server('192.168.1.10', 17890, '   '));
    expect((await loadRecentConnections())[0].name).toBeUndefined();
  });
});

describe('loadLastConnection', () => {
  beforeEach(() => store.clear());

  it('returns the last saved connection', async () => {
    await saveConnection(server('192.168.1.10', 17890, 'valiant'));
    expect(await loadLastConnection()).toEqual(server('192.168.1.10', 17890, 'valiant'));
  });

  it('returns null when nothing is saved', async () => {
    expect(await loadLastConnection()).toBeNull();
  });

  it('returns null for a corrupted entry', async () => {
    store.set('remcontrol:last-connection', '{not json');
    expect(await loadLastConnection()).toBeNull();
  });
});

describe('forgetConnection', () => {
  beforeEach(() => store.clear());

  it('removes the matching server by ip:port', async () => {
    await saveConnection(server('192.168.1.10'));
    await saveConnection(server('192.168.1.20'));
    const remaining = await forgetConnection(server('192.168.1.10'));
    expect(remaining.map((s) => s.ip)).toEqual(['192.168.1.20']);
    expect((await loadRecentConnections()).map((s) => s.ip)).toEqual(['192.168.1.20']);
  });

  it('does not match on ip alone when port differs', async () => {
    await saveConnection(server('192.168.1.10', 17890));
    await saveConnection(server('192.168.1.10', 17891));
    await forgetConnection(server('192.168.1.10', 17890));
    expect((await loadRecentConnections()).map((s) => s.port)).toEqual([17891]);
  });

  it('leaves the list unchanged when the server is absent', async () => {
    await saveConnection(server('192.168.1.10'));
    const remaining = await forgetConnection(server('192.168.1.99'));
    expect(remaining.map((s) => s.ip)).toEqual(['192.168.1.10']);
  });
});

describe('loadRecentConnections validation', () => {
  beforeEach(() => store.clear());

  it('drops entries missing required fields', async () => {
    store.set(
      'remcontrol:recent-connections',
      JSON.stringify([{ ip: '1.2.3.4' }, server('1.2.3.5')]),
    );
    expect((await loadRecentConnections()).map((s) => s.ip)).toEqual(['1.2.3.5']);
  });

  it('returns an empty list when storage is not an array', async () => {
    store.set('remcontrol:recent-connections', JSON.stringify({ ip: '1.2.3.4' }));
    expect(await loadRecentConnections()).toEqual([]);
  });

  it('returns an empty list on corrupted json', async () => {
    store.set('remcontrol:recent-connections', '{not json');
    expect(await loadRecentConnections()).toEqual([]);
  });
});
