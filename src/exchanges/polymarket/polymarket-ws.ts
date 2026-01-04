import WebSocket from 'ws';
import {
  OrderBookWebSocket,
  type OrderbookUpdate,
  type WebSocketConfig,
} from '../../core/websocket.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const POLYMARKET_PING_INTERVAL = 10000;

interface PolymarketWsConfig extends WebSocketConfig {
  apiKey?: string;
}

export class PolymarketWebSocket extends OrderBookWebSocket {
  readonly wsUrl = WS_URL;
  private assetSubscriptions = new Map<string, string>();
  private initialSubscriptionSent = false;

  constructor(config: PolymarketWsConfig = {}) {
    super({
      ...config,
      pingInterval: POLYMARKET_PING_INTERVAL,
    });
  }

  protected async authenticate(): Promise<void> {
    this.initialSubscriptionSent = false;
  }

  protected async subscribeOrderbook(marketId: string): Promise<void> {
    const assetId = this.assetSubscriptions.get(marketId);
    if (!assetId) return;

    if (!this.initialSubscriptionSent) {
      this.send({
        assets_ids: [assetId],
        type: 'market',
      });
      this.initialSubscriptionSent = true;
    } else {
      this.send({
        assets_ids: [assetId],
        operation: 'subscribe',
      });
    }
  }

  protected async unsubscribeOrderbook(marketId: string): Promise<void> {
    const assetId = this.assetSubscriptions.get(marketId);
    if (!assetId) return;

    this.send({
      assets_ids: [assetId],
      operation: 'unsubscribe',
    });
  }

  protected override startPingTimer(): void {
    this.stopPingTimer();
    const interval = this.config.pingInterval ?? POLYMARKET_PING_INTERVAL;

    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('PING');
      }
    }, interval);
  }

  protected override handleMessage(data: WebSocket.RawData): void {
    this.lastMessageTime = Date.now();

    const message = data.toString();
    if (!message.startsWith('{')) return;

    try {
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
    } catch {
      return;
    }
  }

  protected parseOrderbookMessage(message: Record<string, unknown>): OrderbookUpdate | null {
    if (message.event_type !== 'book') return null;

    const assetId = message.asset_id as string;
    if (!assetId) return null;

    const marketId = this.findMarketIdByAsset(assetId);
    if (!marketId) return null;

    const bids: [number, number][] = [];
    const asks: [number, number][] = [];

    const rawBids = message.bids as Array<{ price: string; size: string }> | undefined;
    const rawAsks = message.asks as Array<{ price: string; size: string }> | undefined;

    if (rawBids) {
      for (const bid of rawBids) {
        const price = Number.parseFloat(bid.price);
        const size = Number.parseFloat(bid.size);
        if (price > 0 && size > 0) {
          bids.push([price, size]);
        }
      }
    }

    if (rawAsks) {
      for (const ask of rawAsks) {
        const price = Number.parseFloat(ask.price);
        const size = Number.parseFloat(ask.size);
        if (price > 0 && size > 0) {
          asks.push([price, size]);
        }
      }
    }

    bids.sort((a, b) => b[0] - a[0]);
    asks.sort((a, b) => a[0] - b[0]);

    return {
      marketId,
      bids,
      asks,
      timestamp: Date.now(),
    };
  }

  async watchOrderbookWithAsset(
    marketId: string,
    assetId: string,
    callback: (marketId: string, orderbook: OrderbookUpdate) => void | Promise<void>
  ): Promise<void> {
    this.assetSubscriptions.set(marketId, assetId);
    await this.watchOrderbook(marketId, callback);
  }

  private findMarketIdByAsset(assetId: string): string | undefined {
    for (const [marketId, asset] of this.assetSubscriptions) {
      if (asset === assetId) {
        return marketId;
      }
    }
    return undefined;
  }
}
