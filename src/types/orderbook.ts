/**
 * Orderbook-related types for market data.
 */

/** Price level: [price, size] */
export type PriceLevel = [price: number, size: number];

/** Normalized orderbook data structure */
export interface Orderbook {
  /** Bids sorted descending by price */
  bids: PriceLevel[];
  /** Asks sorted ascending by price */
  asks: PriceLevel[];
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Asset/token ID */
  assetId: string;
  /** Market ID */
  marketId: string;
}

/** Helper functions for Orderbook */
export const OrderbookUtils = {
  /** Get best bid price */
  bestBid(orderbook: Orderbook): number | null {
    return orderbook.bids[0]?.[0] ?? null;
  },

  /** Get best ask price */
  bestAsk(orderbook: Orderbook): number | null {
    return orderbook.asks[0]?.[0] ?? null;
  },

  /** Get mid price */
  midPrice(orderbook: Orderbook): number | null {
    const bid = OrderbookUtils.bestBid(orderbook);
    const ask = OrderbookUtils.bestAsk(orderbook);
    if (bid === null || ask === null) return null;
    return (bid + ask) / 2;
  },

  /** Get bid-ask spread */
  spread(orderbook: Orderbook): number | null {
    const bid = OrderbookUtils.bestBid(orderbook);
    const ask = OrderbookUtils.bestAsk(orderbook);
    if (bid === null || ask === null) return null;
    return ask - bid;
  },

  /** Create orderbook from REST API response */
  fromRestResponse(
    data: {
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
    },
    tokenId = ''
  ): Orderbook {
    const bids: PriceLevel[] = [];
    const asks: PriceLevel[] = [];

    for (const bid of data.bids ?? []) {
      const price = Number.parseFloat(bid.price);
      const size = Number.parseFloat(bid.size);
      if (price > 0 && size > 0) {
        bids.push([price, size]);
      }
    }

    for (const ask of data.asks ?? []) {
      const price = Number.parseFloat(ask.price);
      const size = Number.parseFloat(ask.size);
      if (price > 0 && size > 0) {
        asks.push([price, size]);
      }
    }

    bids.sort((a, b) => b[0] - a[0]);
    asks.sort((a, b) => a[0] - b[0]);

    return {
      bids,
      asks,
      timestamp: Date.now(),
      assetId: tokenId,
      marketId: '',
    };
  },
} as const;

/** Manages multiple orderbooks efficiently */
export class OrderbookManager {
  private orderbooks = new Map<string, Orderbook>();

  /** Update orderbook for a token */
  update(tokenId: string, orderbook: Orderbook): void {
    this.orderbooks.set(tokenId, orderbook);
  }

  /** Get orderbook for a token */
  get(tokenId: string): Orderbook | undefined {
    return this.orderbooks.get(tokenId);
  }

  /** Get best bid and ask for a token */
  getBestBidAsk(tokenId: string): [bid: number | null, ask: number | null] {
    const orderbook = this.get(tokenId);
    if (!orderbook) return [null, null];
    return [OrderbookUtils.bestBid(orderbook), OrderbookUtils.bestAsk(orderbook)];
  }

  /** Check if we have data for a token */
  hasData(tokenId: string): boolean {
    const orderbook = this.get(tokenId);
    if (!orderbook) return false;
    return orderbook.bids.length > 0 && orderbook.asks.length > 0;
  }

  /** Check if we have data for all tokens */
  hasAllData(tokenIds: string[]): boolean {
    return tokenIds.every((id) => this.hasData(id));
  }

  /** Clear all orderbooks */
  clear(): void {
    this.orderbooks.clear();
  }
}
