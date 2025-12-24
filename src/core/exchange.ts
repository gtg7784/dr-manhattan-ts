import { NetworkError, RateLimitError } from '../errors/index.js';
import {
  type CreateOrderParams,
  type FetchMarketsParams,
  type Market,
  MarketUtils,
  type Order,
  type Position,
} from '../types/index.js';

export interface ExchangeConfig {
  apiKey?: string;
  apiSecret?: string;
  privateKey?: string;
  funder?: string;
  timeout?: number;
  verbose?: boolean;
  rateLimit?: number;
  maxRetries?: number;
  retryDelay?: number;
  retryBackoff?: number;
}

export interface ExchangeCapabilities {
  fetchMarkets: boolean;
  fetchMarket: boolean;
  createOrder: boolean;
  cancelOrder: boolean;
  fetchOrder: boolean;
  fetchOpenOrders: boolean;
  fetchPositions: boolean;
  fetchBalance: boolean;
  websocket: boolean;
}

export abstract class Exchange {
  protected config: ExchangeConfig;
  protected requestTimes: number[] = [];
  protected lastRequestTime = 0;

  abstract readonly id: string;
  abstract readonly name: string;

  constructor(config: ExchangeConfig = {}) {
    this.config = {
      timeout: 30000,
      verbose: false,
      rateLimit: 10,
      maxRetries: 3,
      retryDelay: 1000,
      retryBackoff: 2,
      ...config,
    };
  }

  get verbose(): boolean {
    return this.config.verbose ?? false;
  }

  get timeout(): number {
    return this.config.timeout ?? 30000;
  }

  abstract fetchMarkets(params?: FetchMarketsParams): Promise<Market[]>;
  abstract fetchMarket(marketId: string): Promise<Market>;
  abstract createOrder(params: CreateOrderParams): Promise<Order>;
  abstract cancelOrder(orderId: string, marketId?: string): Promise<Order>;
  abstract fetchOrder(orderId: string, marketId?: string): Promise<Order>;
  abstract fetchOpenOrders(marketId?: string): Promise<Order[]>;
  abstract fetchPositions(marketId?: string): Promise<Position[]>;
  abstract fetchBalance(): Promise<Record<string, number>>;

  describe(): { id: string; name: string; has: ExchangeCapabilities } {
    return {
      id: this.id,
      name: this.name,
      has: {
        fetchMarkets: true,
        fetchMarket: true,
        createOrder: true,
        cancelOrder: true,
        fetchOrder: true,
        fetchOpenOrders: true,
        fetchPositions: true,
        fetchBalance: true,
        websocket: false,
      },
    };
  }

  protected checkRateLimit(): void {
    const currentTime = Date.now();
    const rateLimit = this.config.rateLimit ?? 10;

    this.requestTimes = this.requestTimes.filter((t) => currentTime - t < 1000);

    if (this.requestTimes.length >= rateLimit) {
      const oldestRequest = this.requestTimes[0];
      if (oldestRequest) {
        const sleepTime = 1000 - (currentTime - oldestRequest);
        if (sleepTime > 0) {
          throw new RateLimitError(`Rate limit reached, wait ${sleepTime}ms`, sleepTime);
        }
      }
    }

    this.requestTimes.push(currentTime);
  }

  protected async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = this.config.maxRetries ?? 3;
    const retryDelay = this.config.retryDelay ?? 1000;
    const retryBackoff = this.config.retryBackoff ?? 2;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        this.checkRateLimit();
        return await fn();
      } catch (error) {
        lastError = error as Error;

        if (error instanceof NetworkError || error instanceof RateLimitError) {
          if (attempt < maxRetries) {
            const delay = retryDelay * retryBackoff ** attempt + Math.random() * 1000;
            if (this.verbose) {
              console.log(
                `Attempt ${attempt + 1} failed, retrying in ${delay.toFixed(0)}ms: ${error.message}`
              );
            }
            await this.sleep(delay);
            continue;
          }
        }

        throw error;
      }
    }

    throw lastError;
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected parseDateTime(timestamp: unknown): Date | undefined {
    if (!timestamp) return undefined;
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'number') return new Date(timestamp);
    if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }
    return undefined;
  }

  async findTradeableMarket(
    options: {
      binary?: boolean;
      limit?: number;
      minLiquidity?: number;
    } = {}
  ): Promise<Market | null> {
    const { binary = true, limit = 100, minLiquidity = 0 } = options;

    const markets = await this.fetchMarkets({ limit });

    const suitable: Market[] = [];
    for (const market of markets) {
      if (binary && !MarketUtils.isBinary(market)) continue;
      if (!MarketUtils.isOpen(market)) continue;
      if (market.liquidity < minLiquidity) continue;

      const tokenIds = MarketUtils.getTokenIds(market);
      if (tokenIds.length === 0) continue;

      suitable.push(market);
    }

    if (suitable.length === 0) return null;

    const randomIndex = Math.floor(Math.random() * suitable.length);
    return suitable[randomIndex] ?? null;
  }

  calculateSpread(market: Market): number | null {
    return MarketUtils.spread(market);
  }

  calculateImpliedProbability(price: number): number {
    return Math.max(0, Math.min(1, price));
  }

  calculateExpectedValue(market: Market, outcome: string, price: number): number {
    if (!MarketUtils.isBinary(market)) return 0;

    const probability = this.calculateImpliedProbability(price);
    const payoff = outcome === market.outcomes[0] ? 1.0 : 0.0;
    const cost = price;

    return probability * payoff - cost;
  }

  getOptimalOrderSize(market: Market, maxPositionSize: number): number {
    const liquidityBasedSize = market.liquidity * 0.1;
    return Math.min(maxPositionSize, liquidityBasedSize);
  }
}
