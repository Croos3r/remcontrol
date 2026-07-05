import type { MouseButton, ServerInfo } from './types';

export type ConnectionEvents = {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (message: string) => void;
};

export type WebSocketLike = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

export class Connection {
  private ws: WebSocketLike | null = null;
  private welcomed = false;

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
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', token: this.info.token }));
    };
    ws.onmessage = (event) => {
      try {
        const msg: unknown = JSON.parse(String(event.data));
        if (typeof msg !== 'object' || msg === null) return;
        const { type } = msg as { type?: string };
        if (type === 'welcome') {
          this.welcomed = true;
          this.events.onOpen?.();
        } else if (type === 'error') {
          const { message } = msg as { message?: string };
          this.events.onError?.(message ?? 'server error');
        }
      } catch {
        // ignore unparseable frames
      }
    };
    ws.onerror = () => {
      if (!this.welcomed) this.events.onError?.('connection failed');
    };
    ws.onclose = () => {
      const wasWelcomed = this.welcomed;
      this.welcomed = false;
      if (wasWelcomed) this.events.onClose?.();
    };
  }

  get connected(): boolean {
    return this.welcomed && this.ws?.readyState === 1;
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
  }

  private send(payload: object): void {
    if (this.connected) {
      this.ws?.send(JSON.stringify(payload));
    }
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
