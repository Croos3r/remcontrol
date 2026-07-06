import type { ServerInfo } from './types';

/** Minimal WebSocket surface needed for a reachability probe. The native
 * `WebSocket` satisfies this; tests pass in a stub. */
export type ProbeWebSocket = {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  close(): void;
};

export type ProbeFactory = (url: string) => ProbeWebSocket;

const defaultFactory: ProbeFactory = (url) => new WebSocket(url) as unknown as ProbeWebSocket;

const DEFAULT_TIMEOUT_MS = 3000;

/** Tests whether a remcontrol server is reachable on the network by opening a
 * WebSocket to its `/ws` endpoint and closing immediately on upgrade success.
 *
 * The socket is closed BEFORE the PSK-ECDH handshake runs, so this does NOT
 * evict any currently-active client on that server (the server only replaces
 * the prior session after `authenticate` returns Ok, which requires a full
 * handshake). Returns true if the WebSocket upgrade succeeded, false on
 * error, close, or timeout. Does NOT verify that the saved token is still
 * valid — only that something is listening at `ip:port` and speaks the
 * WebSocket upgrade. */
export function probeServer(
  info: Pick<ServerInfo, 'ip' | 'port'>,
  opts: { createSocket?: ProbeFactory; timeoutMs?: number } = {},
): Promise<boolean> {
  const createSocket = opts.createSocket ?? defaultFactory;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let ws: ProbeWebSocket;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // some shims throw on close after an errored socket
      }
      resolve(result);
    };
    ws = createSocket(`ws://${info.ip}:${info.port}/ws`);
    timer = setTimeout(() => finish(false), timeoutMs);
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}
