import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export const WebSocketState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed',
} as const;
export type WebSocketState = (typeof WebSocketState)[keyof typeof WebSocketState];

export interface WebSocketConfig {
  verbose?: boolean;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  pingInterval?: number;
  pingTimeout?: number;
}

export interface OrderbookUpdate {
  marketId: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
}

export type OrderbookCallback = (
  marketId: string,
  orderbook: OrderbookUpdate
) => void | Promise<void>;

export abstract class OrderBookWebSocket extends EventEmitter {
  protected config: WebSocketConfig;
  protected ws: WebSocket | null = null;
  protected state: WebSocketState = WebSocketState.DISCONNECTED;
  protected reconnectAttempts = 0;
  protected subscriptions = new Map<string, OrderbookCallback>();
  protected pingTimer: ReturnType<typeof setInterval> | null = null;
  protected lastMessageTime = 0;

  abstract readonly wsUrl: string;

  constructor(config: WebSocketConfig = {}) {
    super();
    this.config = {
      verbose: false,
      autoReconnect: true,
      maxReconnectAttempts: 999,
      reconnectDelay: 3000,
      pingInterval: 20000,
      pingTimeout: 10000,
      ...config,
    };
  }

  get isConnected(): boolean {
    return this.state === WebSocketState.CONNECTED;
  }

  protected abstract authenticate(): Promise<void>;
  protected abstract subscribeOrderbook(marketId: string): Promise<void>;
  protected abstract unsubscribeOrderbook(marketId: string): Promise<void>;
  protected abstract parseOrderbookMessage(
    message: Record<string, unknown>
  ): OrderbookUpdate | null;

  async connect(): Promise<void> {
    if (this.state === WebSocketState.CONNECTED) return;

    this.state = WebSocketState.CONNECTING;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', async () => {
        this.state = WebSocketState.CONNECTED;
        this.reconnectAttempts = 0;
        this.lastMessageTime = Date.now();

        if (this.config.verbose) {
          console.log(`WebSocket connected to ${this.wsUrl}`);
        }

        try {
          await this.authenticate();
          for (const marketId of this.subscriptions.keys()) {
            await this.subscribeOrderbook(marketId);
          }
          this.startPingTimer();
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('error', (error) => this.handleError(error));
      this.ws.on('close', () => this.handleClose());
    });
  }

  async disconnect(): Promise<void> {
    this.state = WebSocketState.CLOSED;
    this.config.autoReconnect = false;
    this.stopPingTimer();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async watchOrderbook(marketId: string, callback: OrderbookCallback): Promise<void> {
    this.subscriptions.set(marketId, callback);

    if (this.state !== WebSocketState.CONNECTED) {
      await this.connect();
    }

    await this.subscribeOrderbook(marketId);
  }

  async unwatchOrderbook(marketId: string): Promise<void> {
    if (!this.subscriptions.has(marketId)) return;

    this.subscriptions.delete(marketId);

    if (this.state === WebSocketState.CONNECTED) {
      await this.unsubscribeOrderbook(marketId);
    }
  }

  protected handleMessage(data: WebSocket.RawData): void {
    this.lastMessageTime = Date.now();

    try {
      const message = data.toString();
      if (message === 'PONG' || message === 'PING' || message === '') return;

      const parsed = JSON.parse(message) as Record<string, unknown>;
      const orderbook = this.parseOrderbookMessage(parsed);

      if (orderbook) {
        const callback = this.subscriptions.get(orderbook.marketId);
        if (callback) {
          Promise.resolve(callback(orderbook.marketId, orderbook)).catch((error) => {
            if (this.config.verbose) {
              console.error('Orderbook callback error:', error);
            }
          });
        }
      }
    } catch (error) {
      if (this.config.verbose) {
        console.error('Failed to parse WebSocket message:', error);
      }
    }
  }

  protected handleError(error: Error): void {
    if (this.config.verbose) {
      console.error('WebSocket error:', error);
    }
    this.emit('error', error);
  }

  protected handleClose(): void {
    this.stopPingTimer();

    if (this.config.verbose) {
      console.log('WebSocket connection closed');
    }

    if (this.config.autoReconnect && this.state !== WebSocketState.CLOSED) {
      this.reconnect();
    }
  }

  protected async reconnect(): Promise<void> {
    const maxAttempts = this.config.maxReconnectAttempts ?? 999;
    if (this.reconnectAttempts >= maxAttempts) {
      this.state = WebSocketState.CLOSED;
      return;
    }

    this.state = WebSocketState.RECONNECTING;
    this.reconnectAttempts++;

    const delay = Math.min(
      60000,
      (this.config.reconnectDelay ?? 3000) * 1.5 ** (this.reconnectAttempts - 1)
    );

    if (this.config.verbose) {
      console.log(`Reconnecting in ${delay.toFixed(0)}ms (attempt ${this.reconnectAttempts})`);
    }

    await this.sleep(delay);

    try {
      await this.connect();
    } catch {
      const currentState = this.state as WebSocketState;
      if (this.config.autoReconnect && currentState !== WebSocketState.CLOSED) {
        this.reconnect();
      }
    }
  }

  protected startPingTimer(): void {
    this.stopPingTimer();
    const interval = this.config.pingInterval ?? 20000;

    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, interval);
  }

  protected stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
