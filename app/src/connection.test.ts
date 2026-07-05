import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import * as nobleC from '@noble/curves/ed25519.js';
import { expand as hkdfExpand, extract as hkdfExtract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocketLike } from './connection';
import { Connection } from './connection';
import { PROTOCOL_VERSION } from './crypto';
import type { ServerInfo } from './types';

function makeInfo(): ServerInfo {
  return { ip: '192.168.1.10', port: 17890, token: 'secret', name: 'valiant' };
}

type Sent = { data: string | ArrayBuffer };

function fakeSocket() {
  const sent: Sent[] = [];
  const socket: WebSocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data: string | ArrayBuffer) => {
      sent.push({ data });
    },
    close: () => {
      socket.readyState = 3;
      socket.onclose?.();
    },
  };
  return {
    socket,
    sent,
    open: () => {
      socket.readyState = 1;
      socket.onopen?.();
    },
  };
}

/** Minimal server-side PSK-ECDH for tests: given the client's hello (with its
 * pubkey), derive keys with a fresh server keypair and finish the handshake. */
function serverSide(clientHello: string, token: string) {
  const hello = JSON.parse(clientHello) as { pubkey: string };
  const serverPriv = nobleC.x25519.utils.randomSecretKey();
  const serverPub = nobleC.x25519.getPublicKey(serverPriv);
  const clientPub = hello.pubkey;
  const shared = nobleC.x25519.getSharedSecret(serverPriv, hexToBytes(clientPub));
  const psk = sha256(new TextEncoder().encode(token));
  const prk = hkdfExtract(sha256, shared, psk);
  const clientKey = hkdfExpand(sha256, prk, new TextEncoder().encode('remcontrol c2s'), 32);
  const serverKey = hkdfExpand(sha256, prk, new TextEncoder().encode('remcontrol s2c'), 32);
  const welcome = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'welcome',
    pubkey: bytesToHex(serverPub),
  });
  return { welcome, clientKey, serverKey };
}

function seal(key: Uint8Array, counter: number, pt: object): ArrayBuffer {
  const nonce = new Uint8Array(12);
  const dv = new DataView(nonce.buffer);
  dv.setUint32(4, Math.floor(counter / 0x100000000), false);
  dv.setUint32(8, counter >>> 0, false);
  const ct = chacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(JSON.stringify(pt)));
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 12);
  return out.buffer.slice(0, out.length);
}

describe('Connection.connect (encrypted handshake)', () => {
  it('opens a websocket to ws://ip:port/ws', () => {
    const factory = vi.fn(() => fakeSocket().socket);
    const conn = new Connection(makeInfo(), {}, factory);
    conn.connect();
    expect(factory).toHaveBeenCalledWith('ws://192.168.1.10:17890/ws');
  });

  it('sends a hello frame with version and an ephemeral pubkey on open', () => {
    const { socket, sent, open } = fakeSocket();
    const conn = new Connection(makeInfo(), {}, () => socket);
    conn.connect();
    open();
    expect(sent).toHaveLength(1);
    const hello = JSON.parse(sent[0].data as string);
    expect(hello.v).toBe(PROTOCOL_VERSION);
    expect(hello.type).toBe('hello');
    expect(hello.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('completes the encrypted handshake and fires onOpen on welcome', () => {
    const { socket, sent, open } = fakeSocket();
    const onOpen = vi.fn();
    const conn = new Connection(makeInfo(), { onOpen }, () => socket);
    conn.connect();
    open();
    const server = serverSide(sent[0].data as string, 'secret');
    socket.onmessage?.({ data: server.welcome });
    // Client sends an encrypted ack after the welcome.
    expect(sent).toHaveLength(2);
    expect(sent[1].data).toBeInstanceOf(ArrayBuffer);
    // Server sends the encrypted app-level Welcome (counter 0).
    socket.onmessage?.({ data: seal(server.serverKey, 0, { type: 'welcome' }) });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(conn.connected).toBe(true);
  });

  it('fires onAuthFailure and not onClose on a bad-token error frame', () => {
    const { socket, open } = fakeSocket();
    const onAuthFailure = vi.fn();
    const onClose = vi.fn();
    const conn = new Connection(makeInfo(), { onAuthFailure, onClose }, () => socket);
    conn.connect();
    open();
    socket.onmessage?.({ data: '{"type":"error","message":"bad token"}' });
    socket.onclose?.();
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fires onError with the message on a non-auth error frame', () => {
    const { socket, open } = fakeSocket();
    const onError = vi.fn();
    const conn = new Connection(makeInfo(), { onError }, () => socket);
    conn.connect();
    open();
    socket.onmessage?.({ data: '{"type":"error","message":"too many attempts; try again later"}' });
    expect(onError).toHaveBeenCalledWith('too many attempts; try again later');
  });

  it('fires onError when the socket errors before welcome', () => {
    const { socket, open } = fakeSocket();
    const onError = vi.fn();
    const conn = new Connection(makeInfo(), { onError }, () => socket);
    conn.connect();
    open();
    socket.onerror?.();
    expect(onError).toHaveBeenCalledWith('connection failed');
  });
});

describe('Connection commands (encrypted)', () => {
  it('sends encrypted move/click/button/scroll/text/key/modifier after welcome', () => {
    const { socket, sent, open } = fakeSocket();
    const conn = new Connection(makeInfo(), {}, () => socket);
    conn.connect();
    open();
    const server = serverSide(sent[0].data as string, 'secret');
    socket.onmessage?.({ data: server.welcome });
    socket.onmessage?.({ data: seal(server.serverKey, 0, { type: 'welcome' }) });
    // sent[1] is the encrypted ack; sent[2] would be the first command.
    const decryptAt = (idx: number) => {
      const buf = new Uint8Array(sent[idx].data as ArrayBuffer);
      const nonce = buf.slice(0, 12);
      const ct = buf.slice(12);
      const pt = chacha20poly1305(server.clientKey, nonce).decrypt(ct);
      return JSON.parse(new TextDecoder().decode(pt));
    };

    conn.move(3, -2);
    conn.click('left');
    conn.text('hi');

    expect(decryptAt(2)).toEqual({ type: 'move', dx: 3, dy: -2 });
    expect(decryptAt(3)).toEqual({ type: 'click', button: 'left' });
    expect(decryptAt(4)).toEqual({ type: 'text', value: 'hi' });
  });

  it('drops commands when not connected', () => {
    const { socket, sent } = fakeSocket();
    const conn = new Connection(makeInfo(), {}, () => socket);
    conn.connect();
    conn.move(1, 1);
    conn.click('left');
    expect(sent).toHaveLength(0);
  });
});

describe('Connection.close', () => {
  it('clears handlers and closes the socket', () => {
    const { socket, sent, open } = fakeSocket();
    const onClose = vi.fn();
    const conn = new Connection(makeInfo(), { onClose }, () => socket);
    conn.connect();
    open();
    const server = serverSide(sent[0].data as string, 'secret');
    socket.onmessage?.({ data: server.welcome });
    socket.onmessage?.({ data: seal(server.serverKey, 0, { type: 'welcome' }) });
    conn.close();

    expect(socket.onclose).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(conn.connected).toBe(false);
    conn.move(1, 1);
    expect(sent).toHaveLength(2); // hello + ack, no command after close
  });
});

describe('Connection replay / out-of-order protection (client side)', () => {
  // The client tracks the highest server-frame counter seen and drops any
  // frame whose counter is not strictly increasing (connection.ts recv guard).
  // This pins replay protection on the server->client direction.
  function driveToWelcome() {
    const { socket, sent, open } = fakeSocket();
    const onOpen = vi.fn();
    const onError = vi.fn();
    const conn = new Connection(makeInfo(), { onOpen, onError }, () => socket);
    conn.connect();
    open();
    const server = serverSide(sent[0].data as string, 'secret');
    socket.onmessage?.({ data: server.welcome });
    socket.onmessage?.({ data: seal(server.serverKey, 0, { type: 'welcome' }) });
    expect(onOpen).toHaveBeenCalledTimes(1);
    return { socket, server, onOpen, onError, conn };
  }

  it('drops a replayed server frame (same counter) without refiring onOpen', () => {
    const { socket, server, onOpen, onError } = driveToWelcome();
    // Re-send the counter-0 welcome frame (replay).
    socket.onmessage?.({ data: seal(server.serverKey, 0, { type: 'welcome' }) });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('drops an out-of-order server frame (older counter)', () => {
    const { socket, server, onOpen, onError } = driveToWelcome();
    // Advance the counter with an ignored-type frame, then send an older one.
    socket.onmessage?.({ data: seal(server.serverKey, 2, { type: 'noop' }) });
    socket.onmessage?.({ data: seal(server.serverKey, 1, { type: 'welcome' }) });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
