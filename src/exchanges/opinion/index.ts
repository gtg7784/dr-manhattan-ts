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
  type FetchMarketsParams,
  type Market,
  type Order,
  OrderSide,
  OrderStatus,
  type Position,
} from '../../types/index.js';

const BASE_URL = 'https://proxy.opinion.trade:8443';
const CHAIN_ID = 56;

interface OpinionConfig extends ExchangeConfig {
  apiKey?: string;
  multiSigAddr?: string;
  chainId?: number;
  host?: string;
}

interface ApiResponse<T = unknown> {
  errno: number;
  errmsg?: string;
  result?: {
    data?: T;
    list?: T[];
  };
}

interface RawMarket {
  market_id?: number;
  topic_id?: number;
  id?: number;
  market_title?: string;
  title?: string;
  question?: string;
  yes_token_id?: string;
  no_token_id?: string;
  yes_label?: string;
  no_label?: string;
  volume?: string | number;
  liquidity?: number;
  cutoff_at?: number;
  cutoff_time?: number;
  status?: string;
  condition_id?: string;
  child_markets?: RawMarket[];
  description?: string;
  rules?: string;
  category?: string;
  image_url?: string;
}

interface RawOrder {
  order_id?: string;
  id?: string;
  orderID?: string;
  topic_id?: string;
  market_id?: string;
  side?: number | string;
  side_enum?: string;
  price?: number;
  order_shares?: number;
  maker_amount?: number;
  size?: number;
  filled_shares?: number;
  matched_amount?: number;
  filled?: number;
  status?: number | string;
  outcome?: string;
  created_at?: number | string;
  updated_at?: number | string;
}

interface RawPosition {
  topic_id?: string;
  market_id?: string;
  outcome?: string;
  token_name?: string;
  shares_owned?: number;
  size?: number;
  balance?: number;
  avg_entry_price?: number;
  average_price?: number;
  current_price?: number;
  price?: number;
}

interface RawOrderbookLevel {
  price?: number | string;
  size?: number | string;
}

export class Opinion extends Exchange {
  readonly id = 'opinion';
  readonly name = 'Opinion';

  private readonly apiKey: string;
  private readonly multiSigAddr: string;
  private readonly chainId: number;
  private readonly host: string;
  private wallet: Wallet | null = null;

  constructor(config: OpinionConfig = {}) {
    super(config);
    this.apiKey = config.apiKey ?? '';
    this.multiSigAddr = config.multiSigAddr ?? '';
    this.chainId = config.chainId ?? CHAIN_ID;
    this.host = config.host ?? BASE_URL;

    if (config.privateKey) {
      this.wallet = new Wallet(config.privateKey);
    }
  }

  private async request<T>(
    method: string,
    endpoint: string,
    params?: Record<string, unknown>
  ): Promise<ApiResponse<T>> {
    const url = new URL(`${this.host}${endpoint}`);

    if (method === 'GET' && params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
      headers['X-API-Key'] = this.apiKey;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (method !== 'GET' && params) {
      fetchOptions.body = JSON.stringify(params);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (!response.ok) {
      if (response.status === 429) {
        throw new NetworkError('Rate limited');
      }
      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError('Authentication failed');
      }
      throw new NetworkError(`HTTP ${response.status}`);
    }

    return response.json() as Promise<ApiResponse<T>>;
  }

  private ensureAuth(): void {
    if (!this.apiKey || !this.wallet || !this.multiSigAddr) {
      throw new AuthenticationError('API key, private key, and multiSigAddr required');
    }
  }

  private parseMarket(data: RawMarket, _fetchPrices = false): Market {
    const marketId = String(data.market_id ?? data.topic_id ?? data.id ?? '');
    const question = data.market_title ?? data.title ?? data.question ?? '';

    let outcomes: string[] = [];
    const tokenIds: string[] = [];
    const prices: Record<string, number> = {};

    const yesTokenId = String(data.yes_token_id ?? '');
    const noTokenId = String(data.no_token_id ?? '');
    const yesLabel = data.yes_label ?? 'Yes';
    const noLabel = data.no_label ?? 'No';

    const childMarkets = data.child_markets ?? [];

    if (yesTokenId && noTokenId) {
      outcomes = [yesLabel, noLabel];
      tokenIds.push(yesTokenId, noTokenId);
    } else if (childMarkets.length > 0) {
      for (const child of childMarkets) {
        const childTitle = child.market_title ?? '';
        const childYesToken = String(child.yes_token_id ?? '');
        if (childTitle && childYesToken) {
          outcomes.push(childTitle);
          tokenIds.push(childYesToken);
        }
      }
    }

    if (outcomes.length === 0) {
      outcomes = ['Yes', 'No'];
    }

    let closeTime: Date | undefined;
    const cutoffTime = data.cutoff_at ?? data.cutoff_time;
    if (cutoffTime && typeof cutoffTime === 'number' && cutoffTime > 0) {
      closeTime = new Date(cutoffTime * 1000);
    }

    const volume =
      typeof data.volume === 'string' ? Number.parseFloat(data.volume) : (data.volume ?? 0);
    const liquidity = data.liquidity ?? 0;
    const tickSize = 0.001;

    const metadata: Record<string, unknown> = {
      topic_id: marketId,
      market_id: marketId,
      condition_id: data.condition_id ?? '',
      status: data.status ?? '',
      chain_id: this.chainId,
      clobTokenIds: tokenIds,
      token_ids: tokenIds,
      tokens: Object.fromEntries(outcomes.map((o, i) => [o, tokenIds[i] ?? ''])),
      description: data.description ?? data.rules ?? '',
      category: data.category ?? '',
      image_url: data.image_url ?? '',
      minimum_tick_size: tickSize,
      closed: data.status === 'RESOLVED',
    };

    return {
      id: marketId,
      question,
      outcomes,
      closeTime,
      volume,
      liquidity,
      prices,
      tickSize,
      description: String(metadata.description ?? ''),
      metadata,
    };
  }

  private parseOrder(data: RawOrder): Order {
    const orderId = String(data.order_id ?? data.id ?? data.orderID ?? '');
    const marketId = String(data.topic_id ?? data.market_id ?? '');

    let side: OrderSide;
    if (data.side_enum) {
      side = data.side_enum.toLowerCase() === 'buy' ? OrderSide.BUY : OrderSide.SELL;
    } else if (typeof data.side === 'string') {
      side = data.side.toLowerCase() === 'buy' ? OrderSide.BUY : OrderSide.SELL;
    } else {
      side = data.side === 1 ? OrderSide.BUY : OrderSide.SELL;
    }

    const statusVal = data.status;
    let status: OrderStatus;
    if (typeof statusVal === 'number') {
      const statusMap: Record<number, OrderStatus> = {
        0: OrderStatus.PENDING,
        1: OrderStatus.OPEN,
        2: OrderStatus.FILLED,
        3: OrderStatus.PARTIALLY_FILLED,
        4: OrderStatus.CANCELLED,
      };
      status = statusMap[statusVal] ?? OrderStatus.OPEN;
    } else {
      const strStatus = String(statusVal).toLowerCase();
      if (strStatus === 'filled' || strStatus === 'matched') {
        status = OrderStatus.FILLED;
      } else if (strStatus === 'cancelled' || strStatus === 'canceled') {
        status = OrderStatus.CANCELLED;
      } else if (strStatus === 'partially_filled') {
        status = OrderStatus.PARTIALLY_FILLED;
      } else if (strStatus === 'pending') {
        status = OrderStatus.PENDING;
      } else {
        status = OrderStatus.OPEN;
      }
    }

    const price = data.price ?? 0;
    const size = data.order_shares ?? data.maker_amount ?? data.size ?? 0;
    const filled = data.filled_shares ?? data.matched_amount ?? data.filled ?? 0;

    let createdAt = new Date();
    if (data.created_at) {
      createdAt =
        typeof data.created_at === 'number'
          ? new Date(data.created_at * 1000)
          : new Date(data.created_at);
    }

    return {
      id: orderId,
      marketId,
      outcome: data.outcome ?? '',
      side,
      price,
      size,
      filled,
      status,
      createdAt,
    };
  }

  private parsePosition(data: RawPosition): Position {
    return {
      marketId: String(data.topic_id ?? data.market_id ?? ''),
      outcome: data.outcome ?? data.token_name ?? '',
      size: data.shares_owned ?? data.size ?? data.balance ?? 0,
      averagePrice: data.avg_entry_price ?? data.average_price ?? 0,
      currentPrice: data.current_price ?? data.price ?? 0,
    };
  }

  async fetchMarkets(params?: FetchMarketsParams): Promise<Market[]> {
    return this.withRetry(async () => {
      const queryParams: Record<string, unknown> = {
        topic_type: 'ALL',
        status: params?.active === false ? 'ALL' : 'ACTIVATED',
        page: params?.offset ? Math.floor(params.offset / 20) + 1 : 1,
        limit: Math.min(params?.limit ?? 20, 20),
      };

      const response = await this.request<RawMarket>('GET', '/api/v1/markets', queryParams);

      if (response.errno !== 0) {
        throw new ExchangeError(`Failed to fetch markets: ${response.errmsg}`);
      }

      const marketsList = response.result?.list ?? [];
      const markets = marketsList.map((m) => this.parseMarket(m));

      if (params?.limit) {
        return markets.slice(0, params.limit);
      }
      return markets;
    });
  }

  async fetchMarket(marketId: string): Promise<Market> {
    return this.withRetry(async () => {
      const response = await this.request<RawMarket>('GET', `/api/v1/markets/${marketId}`);

      if (response.errno !== 0 || !response.result?.data) {
        throw new MarketNotFound(`Market ${marketId} not found`);
      }

      return this.parseMarket(response.result.data, true);
    });
  }

  async getOrderbook(tokenId: string): Promise<{
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
  }> {
    return this.withRetry(async () => {
      const response = await this.request<{
        bids?: RawOrderbookLevel[];
        asks?: RawOrderbookLevel[];
      }>('GET', '/api/v1/orderbook', { token_id: tokenId });

      const bids: Array<{ price: string; size: string }> = [];
      const asks: Array<{ price: string; size: string }> = [];

      if (response.errno === 0 && response.result) {
        const result = response.result as unknown as {
          bids?: RawOrderbookLevel[];
          asks?: RawOrderbookLevel[];
        };

        for (const bid of result.bids ?? []) {
          const price = Number(bid.price);
          const size = Number(bid.size);
          if (price > 0 && size > 0) {
            bids.push({ price: String(price), size: String(size) });
          }
        }

        for (const ask of result.asks ?? []) {
          const price = Number(ask.price);
          const size = Number(ask.size);
          if (price > 0 && size > 0) {
            asks.push({ price: String(price), size: String(size) });
          }
        }

        bids.sort((a, b) => Number(b.price) - Number(a.price));
        asks.sort((a, b) => Number(a.price) - Number(b.price));
      }

      return { bids, asks };
    });
  }

  async createOrder(params: CreateOrderParams): Promise<Order> {
    this.ensureAuth();

    const tokenId = params.tokenId ?? (params.params?.token_id as string | undefined);
    if (!tokenId) {
      throw new InvalidOrder('token_id required in params');
    }

    if (params.price <= 0 || params.price >= 1) {
      throw new InvalidOrder('Price must be between 0 and 1');
    }

    return this.withRetry(async () => {
      const orderData = {
        market_id: Number(params.marketId),
        token_id: tokenId,
        side: params.side === OrderSide.BUY ? 1 : 2,
        price: String(params.price),
        size: String(params.size),
        order_type: 'LIMIT',
      };

      const response = await this.request<{ order_id?: string }>(
        'POST',
        '/api/v1/orders',
        orderData
      );

      if (response.errno !== 0) {
        throw new InvalidOrder(`Order failed: ${response.errmsg}`);
      }

      const orderId = response.result?.data?.order_id ?? '';

      return {
        id: orderId,
        marketId: params.marketId,
        outcome: params.outcome,
        side: params.side,
        price: params.price,
        size: params.size,
        filled: 0,
        status: OrderStatus.OPEN,
        createdAt: new Date(),
      };
    });
  }

  async cancelOrder(orderId: string, marketId?: string): Promise<Order> {
    this.ensureAuth();

    return this.withRetry(async () => {
      const response = await this.request('POST', `/api/v1/orders/${orderId}/cancel`);

      if (response.errno !== 0) {
        throw new ExchangeError(`Failed to cancel order: ${response.errmsg}`);
      }

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
      };
    });
  }

  async fetchOrder(orderId: string, _marketId?: string): Promise<Order> {
    this.ensureAuth();

    return this.withRetry(async () => {
      const response = await this.request<RawOrder>('GET', `/api/v1/orders/${orderId}`);

      if (response.errno !== 0 || !response.result?.data) {
        throw new ExchangeError(`Order ${orderId} not found`);
      }

      return this.parseOrder(response.result.data);
    });
  }

  async fetchOpenOrders(marketId?: string): Promise<Order[]> {
    this.ensureAuth();

    return this.withRetry(async () => {
      const params: Record<string, unknown> = {
        status: '1',
        page: 1,
        limit: 100,
      };

      if (marketId) {
        params.market_id = Number(marketId);
      }

      const response = await this.request<RawOrder>('GET', '/api/v1/orders', params);

      if (response.errno !== 0) {
        return [];
      }

      const ordersList = response.result?.list ?? [];
      return ordersList.map((o) => this.parseOrder(o));
    });
  }

  async fetchPositions(marketId?: string): Promise<Position[]> {
    this.ensureAuth();

    return this.withRetry(async () => {
      const params: Record<string, unknown> = {
        page: 1,
        limit: 100,
      };

      if (marketId) {
        params.market_id = Number(marketId);
      }

      const response = await this.request<RawPosition>('GET', '/api/v1/positions', params);

      if (response.errno !== 0) {
        return [];
      }

      const positionsList = response.result?.list ?? [];
      return positionsList.map((p) => this.parsePosition(p));
    });
  }

  async fetchBalance(): Promise<Record<string, number>> {
    this.ensureAuth();

    return this.withRetry(async () => {
      const response = await this.request<{ balances?: Array<{ available_balance?: number }> }>(
        'GET',
        '/api/v1/balances'
      );

      if (response.errno !== 0) {
        throw new ExchangeError(`Failed to fetch balance: ${response.errmsg}`);
      }

      const result = response.result as unknown as {
        balances?: Array<{ available_balance?: number }>;
      };
      const balances = result?.balances ?? [];

      if (balances.length > 0) {
        const balance = balances[0]?.available_balance ?? 0;
        return { USDC: balance };
      }

      return { USDC: 0 };
    });
  }

  override describe() {
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
}
