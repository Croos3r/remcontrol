import { describe, expect, it, vi } from 'vitest';
import type { WebSocketLike } from './connection';
import { Connection } from './connection';
import type { ServerInfo } from './types';

function makeInfo(): ServerInfo {
  return { ip: '192.168.1.10', port: 17890, token: 'secret', name: 'valiant' };
}

type Sent = { data: string };

function fakeSocket(): { socket: WebSocketLike; sent: Sent[]; open: () => void } {
  const sent: Sent[] = [];
  const socket: WebSocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data: string) => {
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

describe('Connection.connect', () => {
  it('opens a websocket to ws://ip:port/ws', () => {
    const factory = vi.fn(() => fakeSocket().socket);
    const conn = new Connection(makeInfo(), {}, factory);
    conn.connect();
    expect(factory).toHaveBeenCalledWith('ws://192.168.1.10:17890/ws');
  });

  it('sends a hello message with the token on open', () => {
    const { socket, sent, open } = fakeSocket();
    const conn = new Connection(makeInfo(), {}, () => socket);
    conn.connect();
    open();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].data)).toEqual({ type: 'hello', token: 'secret' });
  });

  it('fires onOpen when the server sends welcome', () => {
    const { socket, open } = fakeSocket();
    const onOpen = vi.fn();
    const conn = new Connection(makeInfo(), { onOpen }, () => socket);
    conn.connect();
    open();
    socket.onmessage?.({ data: '{"type":"welcome"}' });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(conn.connected).toBe(true);
  });

  it('fires onError with the message on an error frame', () => {
    const { socket, open } = fakeSocket();
    const onError = vi.fn();
    const conn = new Connection(makeInfo(), { onError }, () => socket);
    conn.connect();
    open();
    socket.onmessage?.({ data: '{"type":"error","message":"bad token"}' });
    expect(onError).toHaveBeenCalledWith('bad token');
  });

  it('uses a default message on error frames without one', () => {
    const { socket, open } = fakeSocket();
    const onError = vi.fn();
    const conn = new Connection(makeInfo(), { onError }, () => socket);
    conn.connect();
    open();
    socket.onmessage?.({ data: '{"type":"error"}' });
    expect(onError).toHaveBeenCalledWith('server error');
  });

  it('ignores unparseable frames without firing events', () => {
    const { socket, open } = fakeSocket();
    const onOpen = vi.fn();
    const onError = vi.fn();
    const conn = new Connection(makeInfo(), { onOpen, onError }, () => socket);
    conn.connect();
    open();
    socket.onmessage?.({ data: '{not json' });
    socket.onmessage?.({ data: 'null' });
    socket.onmessage?.({ data: '"string"' });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(conn.connected).toBe(false);
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

  it('does not fire onError on socket error after welcome', () => {
    const { socket, open } = fakeSocket();
    const onError = vi.fn();
    const conn = new Connection(makeInfo(), { onError }, () => socket);
    conn.connect();
    open();
    socket.onmessage?.({ data: '{"type":"welcome"}' });
    socket.onerror?.();
    expect(onError).not.toHaveBeenCalled();
  });

  it('fires onClose only if welcome was received', () => {
    const { socket, open } = fakeSocket();
    const onClose = vi.fn();
    const conn = new Connection(makeInfo(), { onClose }, () => socket);
    conn.connect();
    open();
    socket.onclose?.();
    expect(onClose).not.toHaveBeenCalled();

    socket.onmessage?.({ data: '{"type":"welcome"}' });
    socket.onclose?.();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Connection commands', () => {
  it('serializes move/click/button/scroll/text/key/modifier', () => {
    const { socket, sent, open } = fakeSocket();
    const conn = new Connection(makeInfo(), {}, () => socket);
    conn.connect();
    open();
    socket.onmessage?.({ data: '{"type":"welcome"}' });

    conn.move(3, -2);
    conn.click('left');
    conn.buttonDown('right');
    conn.buttonUp('right');
    conn.scroll(0, 5);
    conn.text('hi');
    conn.key('enter');
    conn.modifier('ctrl', 'down');

    expect(sent.slice(1).map((s) => JSON.parse(s.data))).toEqual([
      { type: 'move', dx: 3, dy: -2 },
      { type: 'click', button: 'left' },
      { type: 'button', button: 'right', action: 'down' },
      { type: 'button', button: 'right', action: 'up' },
      { type: 'scroll', dx: 0, dy: 5 },
      { type: 'text', value: 'hi' },
      { type: 'key', key: 'enter' },
      { type: 'modifier', key: 'ctrl', action: 'down' },
    ]);
  });

  it('drops commands when not connected', () => {
    const { socket, sent } = fakeSocket();
    const conn = new Connection(makeInfo(), {}, () => socket);
    conn.connect();
    // no open, no welcome
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
    socket.onmessage?.({ data: '{"type":"welcome"}' });
    conn.close();

    expect(socket.onclose).toBeNull();
    expect(socket.onerror).toBeNull();
    // close() triggered the socket's close, but onClose should not fire
    // because handlers were cleared before the socket actually closed.
    expect(onClose).not.toHaveBeenCalled();
    expect(conn.connected).toBe(false);
    // Further sends after close are dropped.
    conn.move(1, 1);
    expect(sent).toHaveLength(1);
  });
});
