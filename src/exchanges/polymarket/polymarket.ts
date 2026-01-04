import { AssetType, ClobClient, Side } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { Exchange, type ExchangeConfig } from '../../core/exchange.js';
import {
  AuthenticationError,
  ExchangeError,
  InvalidOrder,
  MarketNotFound,
  NetworkError,
} from '../../errors/index.js';
import {
  type CreateOrderParams,
  type CryptoHourlyMarket,
  type FetchMarketsParams,
  type Market,
  MarketUtils,
  normalizeTokenSymbol,
  type Order,
  OrderSide,
  OrderStatus,
  type Position,
  type PriceHistoryInterval,
  type PricePoint,
  type PublicTrade,
  type Tag,
} from '../../types/index.js';

const BASE_URL = 'https://gamma-api.polymarket.com';
const CLOB_URL = 'https://clob.polymarket.com';

interface PolymarketConfig extends ExchangeConfig {
  chainId?: number;
  signatureType?: number;
}

export class Polymarket extends Exchange {
  readonly id = 'polymarket';
  readonly name = 'Polymarket';

  private clobClient: ClobClient | null = null;
  private wallet: Wallet | null = null;
  private address: string | null = null;
  private clobClientAuthenticated = false;
  private authConfig: { chainId: number; signatureType: number; funder?: string } | null = null;

  constructor(config: PolymarketConfig = {}) {
    super(config);

    if (config.privateKey) {
      this.initializeClobClient(config);
    }
  }

  override describe() {
    const base = super.describe();
    return { ...base, has: { ...base.has, websocket: true } };
  }

  private initializeClobClient(config: PolymarketConfig): void {
    try {
      const chainId = config.chainId ?? 137;
      const signatureType = config.signatureType ?? 0;

      if (!config.privateKey) {
        return;
      }
      this.wallet = new Wallet(config.privateKey);
      this.clobClient = new ClobClient(
        CLOB_URL,
        chainId,
        this.wallet,
        undefined,
        signatureType,
        config.funder
      );

      this.authConfig = { chainId, signatureType, funder: config.funder };
      this.address = this.wallet.address;
    } catch (error) {
      throw new AuthenticationError(`Failed to initialize CLOB client: ${error}`);
    }
  }

  private async ensureAuthenticated(): Promise<ClobClient> {
    if (!this.clobClient || !this.wallet || !this.authConfig) {
      throw new AuthenticationError('CLOB client not initialized. Private key required.');
    }

    if (this.clobClientAuthenticated) {
      return this.clobClient;
    }

    const creds = await this.clobClient.createOrDeriveApiKey();
    this.clobClient = new ClobClient(
      CLOB_URL,
      this.authConfig.chainId,
      this.wallet,
      creds,
      this.authConfig.signatureType,
      this.authConfig.funder
    );
    this.clobClientAuthenticated = true;

    return this.clobClient;
  }

  async fetchMarkets(params?: FetchMarketsParams): Promise<Market[]> {
    return this.withRetry(async () => {
      const response = await fetch(`${CLOB_URL}/sampling-markets`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new NetworkError(`Failed to fetch markets: ${response.status}`);
      }

      const result = (await response.json()) as { data?: unknown[] };
      const marketsData = result.data ?? (Array.isArray(result) ? result : []);

      let markets = marketsData
        .map((item) => this.parseSamplingMarket(item as Record<string, unknown>))
        .filter((m): m is Market => m !== null);

      if (params?.active || !params?.closed) {
        markets = markets.filter((m) => this.isMarketOpen(m));
      }

      if (params?.limit) {
        markets = markets.slice(0, params.limit);
      }

      return markets;
    });
  }

  async fetchMarket(marketId: string): Promise<Market> {
    return this.withRetry(async () => {
      const response = await fetch(`${CLOB_URL}/markets/${marketId}`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (response.status === 404) {
        throw new MarketNotFound(`Market ${marketId} not found`);
      }

      if (!response.ok) {
        throw new NetworkError(`Failed to fetch market: ${response.status}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const market = this.parseClobMarket(data);
      if (!market) {
        throw new MarketNotFound(`Market ${marketId} not found or invalid`);
      }
      return market;
    });
  }

  async fetchMarketsBySlug(slugOrUrl: string): Promise<Market[]> {
    const slug = this.parseMarketIdentifier(slugOrUrl);
    if (!slug) throw new Error('Empty slug provided');

    return this.withRetry(async () => {
      const response = await fetch(`${BASE_URL}/events?slug=${slug}`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (response.status === 404) {
        throw new MarketNotFound(`Event not found: ${slug}`);
      }

      if (!response.ok) {
        throw new ExchangeError(`Failed to fetch event: ${response.status}`);
      }

      const eventData = (await response.json()) as Array<{ markets?: unknown[] }>;
      if (!eventData.length) {
        throw new MarketNotFound(`Event not found: ${slug}`);
      }

      const event = eventData[0];
      const marketsData = event?.markets ?? [];

      return marketsData.map((m) => this.parseGammaMarket(m as Record<string, unknown>));
    });
  }

  async createOrder(params: CreateOrderParams): Promise<Order> {
    const tokenId = params.tokenId ?? params.params?.token_id;
    if (!tokenId) {
      throw new InvalidOrder('token_id required in params');
    }

    return this.withRetry(async () => {
      const client = await this.ensureAuthenticated();
      const signedOrder = await client.createOrder({
        tokenID: tokenId as string,
        price: params.price,
        size: params.size,
        side: params.side === OrderSide.BUY ? Side.BUY : Side.SELL,
      });

      const result = (await client.postOrder(signedOrder)) as Record<string, unknown>;
      const orderId = (result.orderID as string) ?? '';
      const statusStr = (result.status as string) ?? 'LIVE';

      return {
        id: orderId,
        marketId: params.marketId,
        outcome: params.outcome,
        side: params.side,
        price: params.price,
        size: params.size,
        filled: 0,
        status: this.parseOrderStatus(statusStr),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
  }

  async cancelOrder(orderId: string, marketId?: string): Promise<Order> {
    return this.withRetry(async () => {
      const client = await this.ensureAuthenticated();
      await client.cancelOrder({ orderID: orderId });

      return {
        id: orderId,
        marketId: marketId ?? '',
        outcome: '',
        side: OrderSide.BUY,
        price: 0,
        size: 0,
        filled: 0,
        status: OrderStatus.CANCELLED,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
  }

  async fetchOrder(orderId: string, _marketId?: string): Promise<Order> {
    return this.withRetry(async () => {
      const client = await this.ensureAuthenticated();
      const data = await client.getOrder(orderId);
      return this.parseOrder(data as unknown as Record<string, unknown>);
    });
  }

  async fetchOpenOrders(marketId?: string): Promise<Order[]> {
    return this.withRetry(async () => {
      const client = await this.ensureAuthenticated();
      const response = await client.getOpenOrders();

      let orders = response as unknown as Array<Record<string, unknown>>;

      if (marketId) {
        orders = orders.filter((o) => o.market === marketId);
      }

      return orders.map((o) => this.parseOrder(o));
    });
  }

  async fetchPositions(_marketId?: string): Promise<Position[]> {
    await this.ensureAuthenticated();
    return [];
  }

  async fetchBalance(): Promise<Record<string, number>> {
    return this.withRetry(async () => {
      const client = await this.ensureAuthenticated();
      const balanceData = (await client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      })) as { balance?: string };

      const balance = balanceData.balance ? Number.parseFloat(balanceData.balance) / 1e6 : 0;

      return { USDC: balance };
    });
  }

  async getOrderbook(tokenId: string): Promise<{
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
  }> {
    return this.withRetry(async () => {
      const response = await fetch(`${CLOB_URL}/book?token_id=${tokenId}`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        return { bids: [], asks: [] };
      }

      return response.json() as Promise<{
        bids: Array<{ price: string; size: string }>;
        asks: Array<{ price: string; size: string }>;
      }>;
    });
  }

  private parseMarketIdentifier(identifier: string): string {
    if (!identifier) return '';

    if (identifier.startsWith('http')) {
      const url = identifier.split('?')[0] ?? '';
      const parts = url.replace(/\/$/, '').split('/');
      const eventIndex = parts.indexOf('event');
      if (eventIndex !== -1 && eventIndex + 1 < parts.length) {
        return parts[eventIndex + 1] ?? '';
      }
      return parts[parts.length - 1] ?? '';
    }

    return identifier;
  }

  private parseSamplingMarket(data: Record<string, unknown>): Market | null {
    const conditionId = data.condition_id as string | undefined;
    if (!conditionId) return null;

    const tokens = (data.tokens as Array<Record<string, unknown>>) ?? [];
    const tokenIds: string[] = [];
    const outcomes: string[] = [];
    const prices: Record<string, number> = {};

    for (const token of tokens) {
      if (token.token_id) tokenIds.push(String(token.token_id));
      if (token.outcome) outcomes.push(String(token.outcome));
      if (token.outcome && token.price != null) {
        prices[String(token.outcome)] = Number(token.price);
      }
    }

    const tickSize = (data.minimum_tick_size as number) ?? 0.01;

    return {
      id: conditionId,
      question: (data.question as string) ?? '',
      outcomes: outcomes.length ? outcomes : ['Yes', 'No'],
      closeTime: undefined,
      volume: 0,
      liquidity: 0,
      prices,
      tickSize,
      description: (data.description as string) ?? '',
      metadata: {
        ...data,
        clobTokenIds: tokenIds,
        conditionId,
        minimumTickSize: tickSize,
      },
    };
  }

  private parseClobMarket(data: Record<string, unknown>): Market | null {
    const conditionId = data.condition_id as string | undefined;
    if (!conditionId) return null;

    const tokens = (data.tokens as Array<Record<string, unknown>>) ?? [];
    const tokenIds: string[] = [];
    const outcomes: string[] = [];
    const prices: Record<string, number> = {};

    for (const token of tokens) {
      if (token.token_id) tokenIds.push(String(token.token_id));
      if (token.outcome) outcomes.push(String(token.outcome));
      if (token.outcome && token.price != null) {
        prices[String(token.outcome)] = Number(token.price);
      }
    }

    const tickSize = (data.minimum_tick_size as number) ?? 0.01;
    const closeTime = this.parseDateTime(data.end_date_iso);

    return {
      id: conditionId,
      question: (data.question as string) ?? '',
      outcomes: outcomes.length ? outcomes : ['Yes', 'No'],
      closeTime,
      volume: 0,
      liquidity: 0,
      prices,
      tickSize,
      description: (data.description as string) ?? '',
      metadata: {
        ...data,
        clobTokenIds: tokenIds,
        conditionId,
        minimumTickSize: tickSize,
      },
    };
  }

  private parseGammaMarket(data: Record<string, unknown>): Market {
    let outcomes = (data.outcomes as string[]) ?? [];
    if (typeof data.outcomes === 'string') {
      try {
        outcomes = JSON.parse(data.outcomes) as string[];
      } catch {
        outcomes = [];
      }
    }

    let pricesList: unknown[] = [];
    if (data.outcomePrices != null) {
      if (typeof data.outcomePrices === 'string') {
        try {
          pricesList = JSON.parse(data.outcomePrices) as unknown[];
        } catch {
          pricesList = [];
        }
      } else if (Array.isArray(data.outcomePrices)) {
        pricesList = data.outcomePrices;
      }
    }

    const prices: Record<string, number> = {};
    for (let i = 0; i < outcomes.length && i < pricesList.length; i++) {
      const outcome = outcomes[i];
      const price = pricesList[i];
      if (outcome && price != null) {
        const priceVal = Number(price);
        if (priceVal > 0) {
          prices[outcome] = priceVal;
        }
      }
    }

    const closeTime = this.parseDateTime(data.endDate);
    const volume = Number(data.volumeNum ?? data.volume ?? 0);
    const liquidity = Number(data.liquidityNum ?? data.liquidity ?? 0);
    const tickSize = (data.minimum_tick_size as number) ?? 0.01;

    let clobTokenIds = data.clobTokenIds as string[] | string | undefined;
    if (typeof clobTokenIds === 'string') {
      try {
        clobTokenIds = JSON.parse(clobTokenIds) as string[];
      } catch {
        clobTokenIds = undefined;
      }
    }

    return {
      id: (data.id as string) ?? '',
      question: (data.question as string) ?? '',
      outcomes,
      closeTime,
      volume,
      liquidity,
      prices,
      tickSize,
      description: (data.description as string) ?? '',
      metadata: {
        ...data,
        clobTokenIds,
        minimumTickSize: tickSize,
      },
    };
  }

  private parseOrder(data: Record<string, unknown>): Order {
    const orderId = (data.id as string) ?? (data.orderID as string) ?? '';
    const size = Number(data.size ?? data.original_size ?? data.amount ?? 0);
    const filled = Number(data.filled ?? data.matched ?? 0);

    return {
      id: orderId,
      marketId: (data.market_id as string) ?? (data.market as string) ?? '',
      outcome: (data.outcome as string) ?? '',
      side:
        ((data.side as string) ?? 'buy').toLowerCase() === 'buy' ? OrderSide.BUY : OrderSide.SELL,
      price: Number(data.price ?? 0),
      size,
      filled,
      status: this.parseOrderStatus(data.status as string),
      createdAt: this.parseDateTime(data.created_at) ?? new Date(),
      updatedAt: this.parseDateTime(data.updated_at),
    };
  }

  private parseOrderStatus(status: string | undefined): OrderStatus {
    const statusMap: Record<string, OrderStatus> = {
      pending: OrderStatus.PENDING,
      open: OrderStatus.OPEN,
      live: OrderStatus.OPEN,
      filled: OrderStatus.FILLED,
      matched: OrderStatus.FILLED,
      partially_filled: OrderStatus.PARTIALLY_FILLED,
      cancelled: OrderStatus.CANCELLED,
      canceled: OrderStatus.CANCELLED,
      rejected: OrderStatus.REJECTED,
    };

    return statusMap[(status ?? '').toLowerCase()] ?? OrderStatus.OPEN;
  }

  private isMarketOpen(market: Market): boolean {
    if (market.metadata.closed) return false;
    if (!market.closeTime) return true;
    return new Date() < market.closeTime;
  }

  get walletAddress(): string | null {
    return this.address;
  }

  async fetchTokenIds(conditionId: string): Promise<string[]> {
    return this.withRetry(async () => {
      const response = await fetch(`${CLOB_URL}/simplified-markets`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new ExchangeError(`Failed to fetch markets: ${response.status}`);
      }

      const result = (await response.json()) as { data?: Array<Record<string, unknown>> };
      const markets = result.data ?? [];

      for (const market of markets) {
        const marketId = (market.condition_id as string) ?? (market.id as string);
        if (marketId === conditionId) {
          const tokens = (market.tokens as Array<{ token_id?: string }>) ?? [];
          return tokens.map((t) => String(t.token_id ?? '')).filter(Boolean);
        }
      }

      throw new ExchangeError(`Token IDs not found for market ${conditionId}`);
    });
  }

  async fetchPositionsForMarket(market: Market): Promise<Position[]> {
    const client = this.clobClient;
    if (!client) {
      throw new AuthenticationError('CLOB client not initialized. Private key required.');
    }

    const positions: Position[] = [];
    const tokenIds = MarketUtils.getTokenIds(market);

    if (tokenIds.length < 2) return positions;

    for (let i = 0; i < tokenIds.length; i++) {
      const tokenId = tokenIds[i];
      if (!tokenId) continue;

      try {
        const balanceData = (await client.getBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: tokenId,
        })) as { balance?: string };

        const balance = balanceData.balance ? Number.parseFloat(balanceData.balance) / 1e6 : 0;

        if (balance > 0) {
          const outcome = market.outcomes[i] ?? (i === 0 ? 'Yes' : 'No');
          const currentPrice = market.prices[outcome] ?? 0;

          positions.push({
            marketId: market.id,
            outcome,
            size: balance,
            averagePrice: 0,
            currentPrice,
          });
        }
      } catch {}
    }

    return positions;
  }

  async fetchPriceHistory(
    marketOrId: Market | string,
    options: {
      outcome?: number | string;
      interval?: PriceHistoryInterval;
      fidelity?: number;
    } = {}
  ): Promise<PricePoint[]> {
    const { outcome = 0, interval = '1m', fidelity = 10 } = options;

    const market = typeof marketOrId === 'string' ? await this.fetchMarket(marketOrId) : marketOrId;
    const tokenIds = MarketUtils.getTokenIds(market);

    let outcomeIndex: number;
    if (typeof outcome === 'number') {
      outcomeIndex = outcome;
    } else {
      outcomeIndex = market.outcomes.indexOf(outcome);
      if (outcomeIndex === -1) outcomeIndex = 0;
    }

    const tokenId = tokenIds[outcomeIndex];
    if (!tokenId) {
      throw new ExchangeError('Cannot fetch price history without token ID');
    }

    return this.withRetry(async () => {
      const url = `${CLOB_URL}/prices-history?market=${tokenId}&interval=${interval}&fidelity=${fidelity}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(this.timeout) });

      if (!response.ok) {
        throw new NetworkError(`Failed to fetch price history: ${response.status}`);
      }

      const data = (await response.json()) as { history?: Array<{ t?: number; p?: number }> };
      const history = data.history ?? [];

      return history
        .filter((h) => h.t != null && h.p != null)
        .map((h) => ({
          timestamp: new Date((h.t ?? 0) * 1000),
          price: h.p ?? 0,
          raw: h as Record<string, unknown>,
        }))
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    });
  }

  async searchMarkets(
    options: {
      limit?: number;
      offset?: number;
      order?: string;
      ascending?: boolean;
      closed?: boolean;
      tagId?: string;
      query?: string;
      binary?: boolean;
      minLiquidity?: number;
    } = {}
  ): Promise<Market[]> {
    const {
      limit = 200,
      offset = 0,
      order = 'volume',
      ascending = false,
      closed = false,
      tagId,
      query,
      binary,
      minLiquidity = 0,
    } = options;

    return this.withRetry(async () => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        order,
        ascending: String(ascending),
        closed: String(closed),
      });

      if (tagId) params.set('tag_id', tagId);

      const response = await fetch(`${BASE_URL}/markets?${params}`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new NetworkError(`Failed to search markets: ${response.status}`);
      }

      const data = (await response.json()) as Array<Record<string, unknown>>;
      let markets = data.map((m) => this.parseGammaMarket(m));

      if (binary !== undefined) {
        markets = markets.filter((m) => MarketUtils.isBinary(m) === binary);
      }

      if (minLiquidity > 0) {
        markets = markets.filter((m) => m.liquidity >= minLiquidity);
      }

      if (query) {
        const q = query.toLowerCase();
        markets = markets.filter(
          (m) => m.question.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)
        );
      }

      return markets;
    });
  }

  async fetchPublicTrades(
    options: {
      market?: Market | string;
      limit?: number;
      offset?: number;
      side?: 'BUY' | 'SELL';
      user?: string;
    } = {}
  ): Promise<PublicTrade[]> {
    const { limit = 100, offset = 0, side, user } = options;

    let conditionId: string | undefined;
    if (options.market) {
      conditionId =
        typeof options.market === 'string'
          ? options.market
          : ((options.market.metadata.conditionId as string) ?? options.market.id);
    }

    return this.withRetry(async () => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        takerOnly: 'true',
      });

      if (conditionId) params.set('market', conditionId);
      if (side) params.set('side', side);
      if (user) params.set('user', user);

      const response = await fetch(`https://data-api.polymarket.com/trades?${params}`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new NetworkError(`Failed to fetch trades: ${response.status}`);
      }

      const data = (await response.json()) as Array<Record<string, unknown>>;

      return data.map((row) => {
        const ts = row.timestamp;
        let timestamp: Date;
        if (typeof ts === 'number') {
          timestamp = new Date(ts * 1000);
        } else if (typeof ts === 'string' && /^\d+$/.test(ts)) {
          timestamp = new Date(Number.parseInt(ts, 10) * 1000);
        } else {
          timestamp = new Date(0);
        }

        return {
          proxyWallet: String(row.proxyWallet ?? ''),
          side: String(row.side ?? ''),
          asset: String(row.asset ?? ''),
          conditionId: String(row.conditionId ?? ''),
          size: Number(row.size ?? 0),
          price: Number(row.price ?? 0),
          timestamp,
          title: row.title as string | undefined,
          slug: row.slug as string | undefined,
          icon: row.icon as string | undefined,
          eventSlug: row.eventSlug as string | undefined,
          outcome: row.outcome as string | undefined,
          outcomeIndex: row.outcomeIndex as number | undefined,
          name: row.name as string | undefined,
          pseudonym: row.pseudonym as string | undefined,
          bio: row.bio as string | undefined,
          profileImage: row.profileImage as string | undefined,
          profileImageOptimized: row.profileImageOptimized as string | undefined,
          transactionHash: row.transactionHash as string | undefined,
        };
      });
    });
  }

  async getTagBySlug(slug: string): Promise<Tag> {
    if (!slug) throw new Error('slug must be a non-empty string');

    return this.withRetry(async () => {
      const response = await fetch(`${BASE_URL}/tags/slug/${slug}`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new ExchangeError(`Failed to fetch tag: ${response.status}`);
      }

      const data = (await response.json()) as Record<string, unknown>;

      return {
        id: String(data.id ?? ''),
        label: data.label as string | undefined,
        slug: data.slug as string | undefined,
        forceShow: data.forceShow as boolean | undefined,
        forceHide: data.forceHide as boolean | undefined,
        isCarousel: data.isCarousel as boolean | undefined,
        publishedAt: data.publishedAt as string | undefined,
        createdAt: data.createdAt as string | undefined,
        updatedAt: (data.UpdatedAt ?? data.updatedAt) as string | undefined,
        raw: data,
      };
    });
  }

  async findCryptoHourlyMarket(
    options: {
      tokenSymbol?: string;
      minLiquidity?: number;
      limit?: number;
      isActive?: boolean;
      isExpired?: boolean;
    } = {}
  ): Promise<{ market: Market; crypto: CryptoHourlyMarket } | null> {
    const {
      tokenSymbol,
      minLiquidity = 0,
      limit = 100,
      isActive = true,
      isExpired = false,
    } = options;

    const TAG_1H = '102175';

    const markets = await this.searchMarkets({
      limit,
      tagId: TAG_1H,
      closed: false,
      minLiquidity,
    });

    const upDownPattern = /(?<token>Bitcoin|Ethereum|Solana|BTC|ETH|SOL)\s+Up or Down/i;
    const strikePattern =
      /(?:(?<token1>BTC|ETH|SOL|BITCOIN|ETHEREUM|SOLANA)\s+.*?(?<direction>above|below|over|under|reach)\s+[$]?(?<price1>[\d,]+(?:\.\d+)?))|(?:[$]?(?<price2>[\d,]+(?:\.\d+)?)\s+.*?(?<token2>BTC|ETH|SOL|BITCOIN|ETHEREUM|SOLANA))/i;

    for (const market of markets) {
      if (!MarketUtils.isBinary(market) || !MarketUtils.isOpen(market)) continue;

      if (market.closeTime) {
        const now = new Date();
        const timeUntilExpiry = market.closeTime.getTime() - now.getTime();

        if (isExpired && timeUntilExpiry > 0) continue;
        if (!isExpired && timeUntilExpiry <= 0) continue;
        if (isActive && !isExpired && timeUntilExpiry > 3600000) continue;
      }

      const upDownMatch = upDownPattern.exec(market.question);
      if (upDownMatch?.groups) {
        const parsedToken = normalizeTokenSymbol(upDownMatch.groups.token ?? '');
        if (tokenSymbol && parsedToken !== normalizeTokenSymbol(tokenSymbol)) continue;

        return {
          market,
          crypto: {
            tokenSymbol: parsedToken,
            expiryTime: market.closeTime ?? new Date(Date.now() + 3600000),
            strikePrice: null,
            marketType: 'up_down',
          },
        };
      }

      const strikeMatch = strikePattern.exec(market.question);
      if (strikeMatch?.groups) {
        const parsedToken = normalizeTokenSymbol(
          strikeMatch.groups.token1 ?? strikeMatch.groups.token2 ?? ''
        );
        const priceStr = strikeMatch.groups.price1 ?? strikeMatch.groups.price2 ?? '0';
        const parsedPrice = Number.parseFloat(priceStr.replace(/,/g, ''));

        if (tokenSymbol && parsedToken !== normalizeTokenSymbol(tokenSymbol)) continue;

        return {
          market,
          crypto: {
            tokenSymbol: parsedToken,
            expiryTime: market.closeTime ?? new Date(Date.now() + 3600000),
            strikePrice: parsedPrice,
            marketType: 'strike_price',
          },
        };
      }
    }

    return null;
  }
}
