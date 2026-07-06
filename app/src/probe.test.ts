import { describe, expect, it } from 'vitest';
import { probeServer } from './probe';
import type { ServerInfo } from './types';

class MockSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  fireOpen() {
    this.onopen?.();
  }
  fireError() {
    this.onerror?.();
  }
  fireClose() {
    this.onclose?.();
  }
}

function server(ip = '1.2.3.4', port = 17890): ServerInfo {
  return { ip, port, token: 'tok' };
}

describe('probeServer', () => {
  it('resolves true when the WebSocket upgrade opens', async () => {
    const sock = new MockSocket();
    const promise = probeServer(server(), { createSocket: () => sock, timeoutMs: 1000 });
    sock.fireOpen();
    expect(await promise).toBe(true);
  });

  it('closes the socket immediately on open (no handshake sent)', async () => {
    const sock = new MockSocket();
    const promise = probeServer(server(), { createSocket: () => sock, timeoutMs: 1000 });
    sock.fireOpen();
    await promise;
    expect(sock.closed).toBe(true);
  });

  it('resolves false on error before open', async () => {
    const sock = new MockSocket();
    const promise = probeServer(server(), { createSocket: () => sock, timeoutMs: 1000 });
    sock.fireError();
    expect(await promise).toBe(false);
    expect(sock.closed).toBe(true);
  });

  it('resolves false on close before open', async () => {
    const sock = new MockSocket();
    const promise = probeServer(server(), { createSocket: () => sock, timeoutMs: 1000 });
    sock.fireClose();
    expect(await promise).toBe(false);
    expect(sock.closed).toBe(true);
  });

  it('resolves false on timeout', async () => {
    const sock = new MockSocket();
    const promise = probeServer(server(), { createSocket: () => sock, timeoutMs: 40 });
    expect(await promise).toBe(false);
    expect(sock.closed).toBe(true);
  });

  it('only resolves once even if multiple events fire', async () => {
    const sock = new MockSocket();
    const promise = probeServer(server(), { createSocket: () => sock, timeoutMs: 1000 });
    sock.fireOpen();
    sock.fireError();
    sock.fireClose();
    expect(await promise).toBe(true);
  });

  it('targets the /ws endpoint on the given ip and port', async () => {
    const seen: string[] = [];
    const sock = new MockSocket();
    const factory = (url: string) => {
      seen.push(url);
      return sock;
    };
    const promise = probeServer(server('10.0.0.5', 12345), {
      createSocket: factory,
      timeoutMs: 1000,
    });
    sock.fireOpen();
    await promise;
    expect(seen).toEqual(['ws://10.0.0.5:12345/ws']);
  });
});
