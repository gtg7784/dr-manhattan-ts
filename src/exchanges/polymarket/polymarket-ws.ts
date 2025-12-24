import {
  OrderBookWebSocket,
  type OrderbookUpdate,
  type WebSocketConfig,
} from '../../core/websocket.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

interface PolymarketWsConfig extends WebSocketConfig {
  apiKey?: string;
}

export class PolymarketWebSocket extends OrderBookWebSocket {
  readonly wsUrl = WS_URL;
  private apiKey?: string;
  private assetSubscriptions = new Map<string, string>();

  constructor(config: PolymarketWsConfig = {}) {
    super(config);
    this.apiKey = config.apiKey;
  }

  protected async authenticate(): Promise<void> {
    if (this.apiKey) {
      this.send({
        type: 'auth',
        apiKey: this.apiKey,
      });
    }
  }

  protected async subscribeOrderbook(marketId: string): Promise<void> {
    const assetIds = this.assetSubscriptions.get(marketId);
    if (!assetIds) return;

    this.send({
      type: 'subscribe',
      channel: 'book',
      assets_id: assetIds,
    });
  }

  protected async unsubscribeOrderbook(marketId: string): Promise<void> {
    const assetIds = this.assetSubscriptions.get(marketId);
    if (!assetIds) return;

    this.send({
      type: 'unsubscribe',
      channel: 'book',
      assets_id: assetIds,
    });
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
