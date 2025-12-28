import { EventEmitter } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import { type OrderbookCallback, WebSocketState } from '../../core/websocket.js';
import { OrderbookManager } from '../../types/orderbook.js';

const WS_URL = 'wss://ws.limitless.exchange';
const NAMESPACE = '/markets';

export interface LimitlessWsConfig {
  verbose?: boolean;
  sessionCookie?: string;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
}

export interface LimitlessOrderbookUpdate {
  slug: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: Date;
}

export interface LimitlessPriceUpdate {
  marketAddress: string;
  yesPrice: number;
  noPrice: number;
  blockNumber: number;
  timestamp: Date;
}

export interface LimitlessPositionUpdate {
  account: string;
  marketAddress: string;
  tokenId: string;
  balance: number;
  outcomeIndex: number;
  marketType: 'AMM' | 'CLOB';
}

export interface LimitlessTrade {
  id: string;
  orderId: string;
  marketId: string;
  assetId: string;
  side: string;
  price: number;
  size: number;
  fee: number;
  timestamp: Date;
  outcome?: string;
  taker?: string;
  maker?: string;
  transactionHash?: string;
}

type OrderbookUpdateCallback = (update: LimitlessOrderbookUpdate) => void | Promise<void>;
type PriceUpdateCallback = (update: LimitlessPriceUpdate) => void | Promise<void>;
type PositionUpdateCallback = (update: LimitlessPositionUpdate) => void | Promise<void>;
type ErrorCallback = (error: string) => void;
type TradeCallback = (trade: LimitlessTrade) => void;

export class LimitlessWebSocket extends EventEmitter {
  protected config: LimitlessWsConfig;
  protected socket: Socket | null = null;
  protected state: WebSocketState = WebSocketState.DISCONNECTED;
  protected reconnectAttempts = 0;

  protected subscribedSlugs: string[] = [];
  protected subscribedAddresses: string[] = [];

  protected orderbookCallbacks: OrderbookUpdateCallback[] = [];
  protected priceCallbacks: PriceUpdateCallback[] = [];
  protected positionCallbacks: PositionUpdateCallback[] = [];
  protected errorCallbacks: ErrorCallback[] = [];

  readonly orderbookManager = new OrderbookManager();
  protected tokenToSlug = new Map<string, string>();

  constructor(config: LimitlessWsConfig = {}) {
    super();
    this.config = {
      verbose: false,
      autoReconnect: true,
      reconnectDelay: 1000,
      maxReconnectAttempts: 999,
      ...config,
    };
  }

  get isConnected(): boolean {
    return this.state === WebSocketState.CONNECTED && !!this.socket?.connected;
  }

  async connect(): Promise<void> {
    if (this.state === WebSocketState.CONNECTED) return;

    this.state = WebSocketState.CONNECTING;

    return new Promise((resolve, reject) => {
      const extraHeaders: Record<string, string> = {};
      if (this.config.sessionCookie) {
        extraHeaders.Cookie = `limitless_session=${this.config.sessionCookie}`;
      }

      this.socket = io(`${WS_URL}${NAMESPACE}`, {
        transports: ['websocket'],
        reconnection: this.config.autoReconnect,
        reconnectionAttempts: this.config.maxReconnectAttempts,
        reconnectionDelay: this.config.reconnectDelay,
        reconnectionDelayMax: 30000,
        extraHeaders,
      });

      this.setupEventHandlers();

      const connectTimeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      this.socket.on('connect', () => {
        clearTimeout(connectTimeout);
        this.state = WebSocketState.CONNECTED;
        this.reconnectAttempts = 0;

        if (this.config.verbose) {
          console.log('Connected to Limitless WebSocket');
        }

        this.resubscribe().then(resolve).catch(reject);
      });

      this.socket.on('connect_error', (err) => {
        clearTimeout(connectTimeout);
        if (this.state === WebSocketState.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.state = WebSocketState.CLOSED;

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  protected setupEventHandlers(): void {
    if (!this.socket) return;

    this.socket.on('disconnect', () => {
      this.state = WebSocketState.DISCONNECTED;
      if (this.config.verbose) {
        console.log('Disconnected from Limitless WebSocket');
      }
    });

    this.socket.on('orderbookUpdate', (data: Record<string, unknown>) => {
      try {
        const update = this.parseOrderbookUpdate(data);
        if (update) {
          for (const callback of this.orderbookCallbacks) {
            Promise.resolve(callback(update)).catch((e) => {
              if (this.config.verbose) console.error('Orderbook callback error:', e);
            });
          }
        }
      } catch (e) {
        if (this.config.verbose) console.error('Error parsing orderbook update:', e);
      }
    });

    this.socket.on('newPriceData', (data: Record<string, unknown>) => {
      try {
        const update = this.parsePriceUpdate(data);
        if (update) {
          for (const callback of this.priceCallbacks) {
            Promise.resolve(callback(update)).catch((e) => {
              if (this.config.verbose) console.error('Price callback error:', e);
            });
          }
        }
      } catch (e) {
        if (this.config.verbose) console.error('Error parsing price update:', e);
      }
    });

    this.socket.on('positions', (data: Record<string, unknown>) => {
      try {
        const updates = this.parsePositionUpdates(data);
        for (const update of updates) {
          for (const callback of this.positionCallbacks) {
            Promise.resolve(callback(update)).catch((e) => {
              if (this.config.verbose) console.error('Position callback error:', e);
            });
          }
        }
      } catch (e) {
        if (this.config.verbose) console.error('Error parsing position update:', e);
      }
    });

    this.socket.on('authenticated', () => {
      if (this.config.verbose) {
        console.log('Authenticated with Limitless WebSocket');
      }
    });

    this.socket.on('exception', (data: unknown) => {
      const errorMsg = String(data);
      if (this.config.verbose) {
        console.error('WebSocket exception:', errorMsg);
      }
      for (const callback of this.errorCallbacks) {
        callback(errorMsg);
      }
    });

    this.socket.on('system', (data: unknown) => {
      if (this.config.verbose) {
        console.log('System message:', data);
      }
    });
  }

  protected parseOrderbookUpdate(data: Record<string, unknown>): LimitlessOrderbookUpdate | null {
    const slug = (data.marketSlug as string) ?? (data.slug as string) ?? '';
    if (!slug) return null;

    const orderbookData = (data.orderbook as Record<string, unknown>) ?? data;

    const bids: [number, number][] = [];
    const rawBids = orderbookData.bids as Array<{ price?: number; size?: number }> | undefined;
    if (rawBids) {
      for (const bid of rawBids) {
        const price = Number(bid.price ?? 0);
        const size = Number(bid.size ?? 0);
        if (price > 0) {
          bids.push([price, size]);
        }
      }
    }

    const asks: [number, number][] = [];
    const rawAsks = orderbookData.asks as Array<{ price?: number; size?: number }> | undefined;
    if (rawAsks) {
      for (const ask of rawAsks) {
        const price = Number(ask.price ?? 0);
        const size = Number(ask.size ?? 0);
        if (price > 0) {
          asks.push([price, size]);
        }
      }
    }

    bids.sort((a, b) => b[0] - a[0]);
    asks.sort((a, b) => a[0] - b[0]);

    let timestamp: Date;
    const ts = data.timestamp;
    if (typeof ts === 'string') {
      timestamp = new Date(ts);
    } else if (typeof ts === 'number') {
      timestamp = new Date(ts > 1e12 ? ts : ts * 1000);
    } else {
      timestamp = new Date();
    }

    return { slug, bids, asks, timestamp };
  }

  protected parsePriceUpdate(data: Record<string, unknown>): LimitlessPriceUpdate | null {
    const marketAddress = (data.marketAddress as string) ?? '';
    if (!marketAddress) return null;

    const prices = (data.updatedPrices as { yes?: number; no?: number }) ?? {};
    const yesPrice = Number(prices.yes ?? 0);
    const noPrice = Number(prices.no ?? 0);
    const blockNumber = Number(data.blockNumber ?? 0);

    let timestamp: Date;
    const ts = data.timestamp;
    if (typeof ts === 'string') {
      timestamp = new Date(ts);
    } else {
      timestamp = new Date();
    }

    return { marketAddress, yesPrice, noPrice, blockNumber, timestamp };
  }

  protected parsePositionUpdates(data: Record<string, unknown>): LimitlessPositionUpdate[] {
    const updates: LimitlessPositionUpdate[] = [];

    const account = (data.account as string) ?? '';
    const marketAddress = (data.marketAddress as string) ?? '';
    const marketType = ((data.type as string) ?? 'CLOB') as 'AMM' | 'CLOB';

    const positions = (data.positions as Array<Record<string, unknown>>) ?? [];
    for (const pos of positions) {
      updates.push({
        account,
        marketAddress,
        tokenId: String(pos.tokenId ?? ''),
        balance: Number(pos.balance ?? 0),
        outcomeIndex: Number(pos.outcomeIndex ?? 0),
        marketType,
      });
    }

    return updates;
  }

  protected async resubscribe(): Promise<void> {
    if (this.subscribedSlugs.length > 0 || this.subscribedAddresses.length > 0) {
      await this.sendSubscription();
    }
  }

  protected async sendSubscription(): Promise<void> {
    if (!this.socket?.connected) return;

    const payload: Record<string, string[]> = {};
    if (this.subscribedAddresses.length > 0) {
      payload.marketAddresses = this.subscribedAddresses;
    }
    if (this.subscribedSlugs.length > 0) {
      payload.marketSlugs = this.subscribedSlugs;
    }

    if (Object.keys(payload).length > 0) {
      this.socket.emit('subscribe_market_prices', payload);
      if (this.config.verbose) {
        console.log('Subscribed to markets:', payload);
      }
    }
  }

  async subscribeMarket(marketSlug: string): Promise<void> {
    if (!this.subscribedSlugs.includes(marketSlug)) {
      this.subscribedSlugs.push(marketSlug);
    }

    if (this.isConnected) {
      await this.sendSubscription();
    }
  }

  async subscribeMarketAddress(marketAddress: string): Promise<void> {
    if (!this.subscribedAddresses.includes(marketAddress)) {
      this.subscribedAddresses.push(marketAddress);
    }

    if (this.isConnected) {
      await this.sendSubscription();
    }
  }

  async unsubscribeMarket(marketSlug: string): Promise<void> {
    const index = this.subscribedSlugs.indexOf(marketSlug);
    if (index !== -1) {
      this.subscribedSlugs.splice(index, 1);
    }

    if (this.isConnected) {
      await this.sendSubscription();
    }
  }

  async unsubscribeMarketAddress(marketAddress: string): Promise<void> {
    const index = this.subscribedAddresses.indexOf(marketAddress);
    if (index !== -1) {
      this.subscribedAddresses.splice(index, 1);
    }

    if (this.isConnected) {
      await this.sendSubscription();
    }
  }

  onOrderbook(callback: OrderbookUpdateCallback): this {
    this.orderbookCallbacks.push(callback);
    return this;
  }

  onPrice(callback: PriceUpdateCallback): this {
    this.priceCallbacks.push(callback);
    return this;
  }

  onPosition(callback: PositionUpdateCallback): this {
    this.positionCallbacks.push(callback);
    return this;
  }

  onError(callback: ErrorCallback): this {
    this.errorCallbacks.push(callback);
    return this;
  }

  async watchOrderbookByMarket(
    marketSlug: string,
    assetIds: string[],
    callback?: OrderbookCallback
  ): Promise<void> {
    for (const assetId of assetIds) {
      this.tokenToSlug.set(assetId, marketSlug);
    }

    const yesToken = assetIds[0];
    const noToken = assetIds[1];

    const orderbookHandler: OrderbookUpdateCallback = (update) => {
      const ts = update.timestamp.getTime();

      if (yesToken) {
        this.orderbookManager.update(yesToken, {
          bids: update.bids,
          asks: update.asks,
          timestamp: ts,
          assetId: yesToken,
          marketId: update.slug,
        });
      }

      if (noToken) {
        const noBids: [number, number][] = update.asks.map(([price, size]) => [
          Math.round((1 - price) * 1000) / 1000,
          size,
        ]);
        const noAsks: [number, number][] = update.bids.map(([price, size]) => [
          Math.round((1 - price) * 1000) / 1000,
          size,
        ]);
        noBids.sort((a, b) => b[0] - a[0]);
        noAsks.sort((a, b) => a[0] - b[0]);

        this.orderbookManager.update(noToken, {
          bids: noBids,
          asks: noAsks,
          timestamp: ts,
          assetId: noToken,
          marketId: update.slug,
        });
      }

      if (callback) {
        callback(marketSlug, {
          marketId: marketSlug,
          bids: update.bids,
          asks: update.asks,
          timestamp: ts,
        });
      }
    };

    this.onOrderbook(orderbookHandler);

    if (!this.isConnected) {
      await this.connect();
    }

    await this.subscribeMarket(marketSlug);
  }

  getOrderbookManager(): OrderbookManager {
    return this.orderbookManager;
  }
}

export class LimitlessUserWebSocket extends LimitlessWebSocket {
  protected tradeCallbacks: TradeCallback[] = [];

  constructor(sessionCookie: string, config: Omit<LimitlessWsConfig, 'sessionCookie'> = {}) {
    super({ ...config, sessionCookie });
  }

  onTrade(callback: TradeCallback): this {
    this.tradeCallbacks.push(callback);
    return this;
  }

  protected emitTrade(trade: LimitlessTrade): void {
    for (const callback of this.tradeCallbacks) {
      try {
        callback(trade);
      } catch (e) {
        if (this.config.verbose) {
          console.error('Trade callback error:', e);
        }
      }
    }
  }

  async subscribePositions(marketAddresses?: string[]): Promise<void> {
    if (!this.socket?.connected) return;

    const payload: Record<string, unknown> = {};
    if (marketAddresses && marketAddresses.length > 0) {
      payload.marketAddresses = marketAddresses;
    }

    this.socket.emit('subscribe_positions', payload);

    if (this.config.verbose) {
      console.log('Subscribed to position updates:', payload);
    }
  }
}
