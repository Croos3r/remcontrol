import { beginHandshake, finishHandshake, frameCounter, type SessionKeys } from './crypto';
import type { MouseButton, ServerInfo } from './types';

export type ConnectionEvents = {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (message: string) => void;
  /** Emitted when the server rejects the token; the caller should stop
   * reconnecting and surface a re-pair UI (M-5). */
  onAuthFailure?: () => void;
};

export type WebSocketLike = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBufferLike): void;
  close(): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

export class Connection {
  private ws: WebSocketLike | null = null;
  private keys: SessionKeys | null = null;
  private welcomed = false;
  private authFailed = false;
  private sendCounter = 1;
  private recvLast = -1;

  constructor(
    readonly info: ServerInfo,
    private events: ConnectionEvents = {},
    private createSocket: WebSocketFactory = defaultFactory,
  ) {}

  setEvents(events: ConnectionEvents): void {
    this.events = events;
  }

  connect(): void {
    const ws = this.createSocket(`ws://${this.info.ip}:${this.info.port}/ws`);
    this.ws = ws;
    this.welcomed = false;
    this.authFailed = false;
    this.keys = null;
    this.sendCounter = 1;
    this.recvLast = -1;
    // binaryType is needed to receive ArrayBuffer frames. The native
    // WebSocket supports this; the factory shim should too.
    try {
      (ws as unknown as { binaryType: string }).binaryType = 'arraybuffer';
    } catch {
      // some shim implementations may not expose binaryType
    }

    const hs = beginHandshake(this.info.token);
    const clientPriv = hs.clientPriv;

    ws.onopen = () => {
      ws.send(hs.helloFrame);
    };
    ws.onmessage = (event) => {
      this.handleMessage(event.data, clientPriv).catch(() => {
        this.events.onError?.('protocol error');
      });
    };
    ws.onerror = () => {
      if (!this.welcomed) this.events.onError?.('connection failed');
    };
    ws.onclose = () => {
      const wasWelcomed = this.welcomed;
      this.welcomed = false;
      if (this.authFailed) {
        this.events.onAuthFailure?.();
        return;
      }
      if (wasWelcomed) this.events.onClose?.();
    };
  }

  private async handleMessage(data: ArrayBuffer | string, clientPriv: Uint8Array): Promise<void> {
    if (this.keys === null) {
      // Pre-handshake: the server's welcome is a plaintext JSON frame with
      // the ephemeral pubkey. An error frame here means auth failed (M-5).
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      let msg: { type?: string; v?: number; pubkey?: string; message?: string };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.type === 'error') {
        this.authFailed = msg.message?.includes('bad token') ?? false;
        this.events.onError?.(msg.message ?? 'server error');
        return;
      }
      if (msg.type !== 'welcome' || typeof msg.pubkey !== 'string') return;
      const keys = finishHandshake(clientPriv, msg.pubkey, this.info.token);
      this.keys = keys;
      // Send the encrypted ack (app-level Hello) to confirm the key. Sent
      // directly (not via the connected-gated send) because the connection
      // is not yet welcomed.
      const plaintext = new TextEncoder().encode(JSON.stringify({ type: 'hello', token: '' }));
      const frame = keys.encrypt(0, plaintext);
      this.sendCounter = 1;
      this.sendRaw(frame);
      return;
    }
    // Post-handshake: encrypted binary frames only.
    if (typeof data === 'string') return;
    const frame = new Uint8Array(data);
    const counter = frameCounter(frame);
    if (counter < 0 || counter <= this.recvLast) return; // replay / OOO
    const pt = this.keys.decrypt(counter, frame);
    this.recvLast = counter;
    let msg: { type?: string };
    try {
      msg = JSON.parse(new TextDecoder().decode(pt));
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      this.welcomed = true;
      this.events.onOpen?.();
    } else if (msg.type === 'error') {
      this.events.onError?.('server error');
    }
  }

  get connected(): boolean {
    return this.welcomed && this.ws?.readyState === 1;
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    this.keys = null;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
  }

  private sendEncrypted(payload: object): void {
    if (!this.keys) return;
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const frame = this.keys.encrypt(this.sendCounter, plaintext);
    this.sendCounter += 1;
    this.sendRaw(frame);
  }

  private sendRaw(frame: Uint8Array): void {
    if (this.ws?.readyState !== 1) return;
    try {
      this.ws.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
    } catch {
      this.events.onError?.('send failed');
    }
  }

  private send(payload: object): void {
    if (this.connected) this.sendEncrypted(payload);
  }

  move(dx: number, dy: number): void {
    this.send({ type: 'move', dx, dy });
  }
  click(button: MouseButton): void {
    this.send({ type: 'click', button });
  }
  buttonDown(button: MouseButton): void {
    this.send({ type: 'button', button, action: 'down' });
  }
  buttonUp(button: MouseButton): void {
    this.send({ type: 'button', button, action: 'up' });
  }
  scroll(dx: number, dy: number): void {
    this.send({ type: 'scroll', dx, dy });
  }
  text(value: string): void {
    this.send({ type: 'text', value });
  }
  key(key: string): void {
    this.send({ type: 'key', key });
  }
  modifier(key: string, action: 'down' | 'up'): void {
    this.send({ type: 'modifier', key, action });
  }
}
