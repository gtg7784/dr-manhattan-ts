/**
 * Market-related types for prediction markets.
 */

/** Represents a tradeable outcome with its token ID */
export interface OutcomeToken {
  /** Outcome name (e.g., "Yes", "No") */
  outcome: string;
  /** Token ID for trading */
  tokenId: string;
}

/** Represents a prediction market */
export interface Market {
  /** Unique market identifier */
  id: string;
  /** Market question */
  question: string;
  /** List of possible outcomes */
  outcomes: string[];
  /** Market close/resolution time */
  closeTime?: Date;
  /** Total trading volume */
  volume: number;
  /** Available liquidity */
  liquidity: number;
  /** Current prices for each outcome (0-1) */
  prices: Record<string, number>;
  /** Minimum price increment */
  tickSize: number;
  /** Resolution criteria description */
  description: string;
  /** Additional exchange-specific metadata */
  metadata: Record<string, unknown>;
}

/** Helper functions for Market */
export const MarketUtils = {
  /** Check if market is binary (Yes/No) */
  isBinary(market: Market): boolean {
    return market.outcomes.length === 2;
  },

  /** Check if market is still open for trading */
  isOpen(market: Market): boolean {
    if ('closed' in market.metadata && market.metadata.closed) {
      return false;
    }
    if (!market.closeTime) return true;
    return new Date() < market.closeTime;
  },

  /** Get bid-ask spread for binary markets */
  spread(market: Market): number | null {
    if (!MarketUtils.isBinary(market) || market.outcomes.length !== 2) {
      return null;
    }
    const prices = Object.values(market.prices);
    if (prices.length !== 2) return null;
    return Math.abs(1.0 - prices.reduce((a, b) => a + b, 0));
  },

  /** Get token IDs from market metadata */
  getTokenIds(market: Market): string[] {
    const tokenIds = market.metadata.clobTokenIds;
    if (!tokenIds) return [];
    if (typeof tokenIds === 'string') {
      try {
        return JSON.parse(tokenIds) as string[];
      } catch {
        return [];
      }
    }
    if (Array.isArray(tokenIds)) {
      return tokenIds.map(String);
    }
    return [];
  },

  /** Create OutcomeToken array from market */
  getOutcomeTokens(market: Market): OutcomeToken[] {
    const tokenIds = MarketUtils.getTokenIds(market);
    return market.outcomes.map((outcome, i) => ({
      outcome,
      tokenId: tokenIds[i] ?? '',
    }));
  },
} as const;

/** Parameters for fetching markets */
export interface FetchMarketsParams {
  /** Maximum number of markets to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Only return active markets */
  active?: boolean;
  /** Include closed markets */
  closed?: boolean;
  /** Additional exchange-specific filters */
  [key: string]: unknown;
}
