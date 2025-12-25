import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
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
  type Orderbook,
  type Position,
  type PriceLevel,
} from '../../types/index.js';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const DEMO_URL = 'https://demo-api.kalshi.co/trade-api/v2';

export interface KalshiConfig extends ExchangeConfig {
  /** API key ID (the public key identifier) */
  apiKeyId?: string;
  /** Path to RSA private key PEM file */
  privateKeyPath?: string;
  /** RSA private key PEM content (alternative to path) */
  privateKeyPem?: string;
  /** Use demo environment */
  demo?: boolean;
  /** Custom API URL */
  apiUrl?: string;
}

interface KalshiAuth {
  sign(timestampMs: number, method: string, path: string): string;
}

function createAuth(privateKeyPem: string): KalshiAuth {
  return {
    sign(timestampMs: number, method: string, path: string): string {
      const message = `${timestampMs}${method.toUpperCase()}${path}`;
      const sign = crypto.createSign('RSA-SHA256');
      sign.update(message);
      sign.end();
      const signature = sign.sign(privateKeyPem, 'base64');
      return signature;
    },
  };
}

interface RawMarket {
  ticker?: string;
  title?: string;
  subtitle?: string;
  rules_primary?: string;
  yes_ask?: number;
  yes_bid?: number;
  no_ask?: number;
  no_bid?: number;
  last_price?: number;
  volume?: number;
  open_interest?: number;
  close_time?: string;
  expiration_time?: string;
  status?: string;
  result?: string;
  event_ticker?: string;
  category?: string;
  [key: string]: unknown;
}

interface RawOrder {
  order_id?: string;
  ticker?: string;
  action?: string;
  side?: string;
  status?: string;
  yes_price?: number;
  no_price?: number;
  count?: number;
  remaining_count?: number;
  filled_count?: number;
  created_time?: string;
  updated_time?: string;
  [key: string]: unknown;
}

interface RawPosition {
  ticker?: string;
  position?: number;
  market_exposure?: number;
  realized_pnl?: number;
  total_traded?: number;
  [key: string]: unknown;
}

export class Kalshi extends Exchange {
  readonly id = 'kalshi';
  readonly name = 'Kalshi';

  private readonly apiUrl: string;
  private readonly apiKeyId: string | null;
  private auth: KalshiAuth | null = null;

  constructor(config: KalshiConfig = {}) {
    super(config);

    this.apiUrl = config.apiUrl ?? (config.demo ? DEMO_URL : BASE_URL);
    this.apiKeyId = config.apiKeyId ?? null;

    if (config.apiKeyId) {
      if (config.privateKeyPath) {
        const pem = fs.readFileSync(config.privateKeyPath, 'utf-8');
        this.auth = createAuth(pem);
      } else if (config.privateKeyPem) {
        this.auth = createAuth(config.privateKeyPem);
      }
    }
  }

  private isAuthenticated(): boolean {
    return this.apiKeyId !== null && this.auth !== null;
  }

  private ensureAuth(): void {
    if (!this.isAuthenticated()) {
      throw new AuthenticationError('Kalshi requires apiKeyId and privateKey for this operation');
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (this.isAuthenticated() && this.auth && this.apiKeyId) {
      const timestampMs = Date.now();
      const signature = this.auth.sign(timestampMs, method, path);

      headers['KALSHI-ACCESS-KEY'] = this.apiKeyId;
      headers['KALSHI-ACCESS-SIGNATURE'] = signature;
      headers['KALSHI-ACCESS-TIMESTAMP'] = timestampMs.toString();
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeout),
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    if (response.status === 429) {
      throw new NetworkError('Rate limited');
    }

    if (response.status === 401 || response.status === 403) {
      const msg = await response.text();
      throw new AuthenticationError(`Authentication failed: ${msg}`);
    }

    if (response.status === 404) {
      throw new ExchangeError(`Resource not found: ${path}`);
    }

    if (!response.ok) {
      const msg = await response.text();
      throw new NetworkError(`HTTP ${response.status}: ${msg}`);
    }

    return response.json() as Promise<T>;
  }

  private parseMarket(data: RawMarket): Market | null {
    const ticker = data.ticker;
    if (!ticker) return null;

    const question = data.title ?? '';
    const outcomes = ['Yes', 'No'];

    // Kalshi prices are in cents (1-99), convert to decimal (0.01-0.99)
    const yesPrice = (data.yes_ask ?? data.yes_bid ?? data.last_price ?? 50) / 100;
    const noPrice = 1 - yesPrice;

    const prices: Record<string, number> = {
      Yes: yesPrice,
      No: noPrice,
    };

    const volume = data.volume ?? 0;
    const liquidity = data.open_interest ?? 0;

    let closeTime: Date | undefined;
    const closeTimeStr = data.close_time ?? data.expiration_time;
    if (closeTimeStr) {
      const parsed = this.parseDateTime(closeTimeStr);
      if (parsed) closeTime = parsed;
    }

    const description = data.subtitle ?? data.rules_primary ?? '';

    // Kalshi uses 0.01 tick size (1 cent)
    const tickSize = 0.01;

    const status = data.status ?? '';
    const closed =
      status.toLowerCase() === 'closed' ||
      status.toLowerCase() === 'settled' ||
      data.result != null;

    return {
      id: ticker,
      question,
      outcomes,
      closeTime,
      volume,
      liquidity,
      prices,
      tickSize,
      description,
      metadata: {
        ...data,
        ticker,
        eventTicker: data.event_ticker,
        closed,
      },
    };
  }

  private parseOrder(data: RawOrder): Order {
    const orderId = data.order_id ?? '';
    const marketId = data.ticker ?? '';

    // Kalshi uses 'action' for buy/sell and 'side' for yes/no
    const action = (data.action ?? 'buy').toLowerCase();
    const side = action === 'buy' ? OrderSide.BUY : OrderSide.SELL;

    const outcomeSide = (data.side ?? 'yes').toLowerCase();
    const outcome = outcomeSide === 'yes' ? 'Yes' : 'No';

    const statusStr = (data.status ?? 'resting').toLowerCase();
    let status: OrderStatus;
    switch (statusStr) {
      case 'resting':
      case 'active':
      case 'pending':
        status = OrderStatus.OPEN;
        break;
      case 'executed':
      case 'filled':
        status = OrderStatus.FILLED;
        break;
      case 'canceled':
      case 'cancelled':
        status = OrderStatus.CANCELLED;
        break;
      case 'partial':
        status = OrderStatus.PARTIALLY_FILLED;
        break;
      default:
        status = OrderStatus.OPEN;
    }

    // Price in cents, convert to decimal
    const priceCents = data.yes_price ?? data.no_price ?? 0;
    const price = priceCents / 100;

    const size = data.count ?? data.remaining_count ?? 0;
    const filled = data.filled_count ?? 0;

    let createdAt = new Date();
    if (data.created_time) {
      const parsed = this.parseDateTime(data.created_time);
      if (parsed) createdAt = parsed;
    }

    let updatedAt: Date | undefined;
    if (data.updated_time) {
      updatedAt = this.parseDateTime(data.updated_time);
    }

    return {
      id: orderId,
      marketId,
      outcome,
      side,
      price,
      size,
      filled,
      status,
      createdAt,
      updatedAt,
    };
  }

  private parsePosition(data: RawPosition): Position {
    const marketId = data.ticker ?? '';

    // Kalshi position: positive = Yes, negative = No
    const positionValue = data.position ?? 0;
    const outcome = positionValue >= 0 ? 'Yes' : 'No';
    const size = Math.abs(positionValue);

    // Kalshi doesn't provide average price directly in positions
    const averagePrice = 0;
    const currentPrice = 0;

    return {
      marketId,
      outcome,
      size,
      averagePrice,
      currentPrice,
    };
  }

  async fetchMarkets(params?: FetchMarketsParams): Promise<Market[]> {
    return this.withRetry(async () => {
      const limit = params?.limit ?? 100;
      let endpoint = `/markets?limit=${Math.min(limit, 200)}`;

      if (params?.active !== false) {
        endpoint += '&status=open';
      }

      interface MarketsResponse {
        markets: RawMarket[];
        cursor?: string;
      }

      const response = await this.request<MarketsResponse>('GET', endpoint);
      const markets = response.markets ?? [];

      return markets.map((m) => this.parseMarket(m)).filter((m): m is Market => m !== null);
    });
  }

  async fetchMarket(marketId: string): Promise<Market> {
    return this.withRetry(async () => {
      interface MarketResponse {
        market: RawMarket;
      }

      try {
        const response = await this.request<MarketResponse>('GET', `/markets/${marketId}`);
        const market = this.parseMarket(response.market);

        if (!market) {
          throw new MarketNotFound(`Market ${marketId} not found`);
        }

        return market;
      } catch (error) {
        if (error instanceof ExchangeError && error.message.includes('not found')) {
          throw new MarketNotFound(`Market ${marketId} not found`);
        }
        throw error;
      }
    });
  }

  async fetchOrderbook(ticker: string): Promise<Orderbook> {
    this.ensureAuth();

    return this.withRetry(async () => {
      interface OrderbookResponse {
        orderbook: {
          yes?: Array<[number, number]>;
          no?: Array<[number, number]>;
        };
      }

      const response = await this.request<OrderbookResponse>('GET', `/markets/${ticker}/orderbook`);

      const bids: PriceLevel[] = [];
      const asks: PriceLevel[] = [];

      // Yes side becomes bids
      if (response.orderbook.yes) {
        for (const [priceCents, size] of response.orderbook.yes) {
          const price = priceCents / 100;
          bids.push([price, size]);
        }
      }

      // No side becomes asks (inverted)
      if (response.orderbook.no) {
        for (const [priceCents, size] of response.orderbook.no) {
          const price = 1 - priceCents / 100;
          asks.push([price, size]);
        }
      }

      // Sort: bids descending, asks ascending
      bids.sort((a, b) => b[0] - a[0]);
      asks.sort((a, b) => a[0] - b[0]);

      return {
        bids,
        asks,
        timestamp: Date.now(),
        assetId: ticker,
        marketId: ticker,
      };
    });
  }

  async createOrder(params: CreateOrderParams): Promise<Order> {
    this.ensureAuth();

    if (params.price <= 0 || params.price >= 1) {
      throw new InvalidOrder('Price must be between 0 and 1');
    }

    const outcome = params.outcome.toLowerCase();
    if (outcome !== 'yes' && outcome !== 'no') {
      throw new InvalidOrder("Outcome must be 'Yes' or 'No'");
    }

    return this.withRetry(async () => {
      const action = params.side === OrderSide.BUY ? 'buy' : 'sell';
      const side = outcome;

      // Price in cents
      const priceCents = Math.round(params.price * 100);

      interface CreateOrderRequest {
        ticker: string;
        action: string;
        side: string;
        type: string;
        count: number;
        yes_price?: number;
        no_price?: number;
      }

      const body: CreateOrderRequest = {
        ticker: params.marketId,
        action,
        side,
        type: 'limit',
        count: Math.floor(params.size),
      };

      if (outcome === 'yes') {
        body.yes_price = priceCents;
      } else {
        body.no_price = priceCents;
      }

      interface CreateOrderResponse {
        order: RawOrder;
      }

      const response = await this.request<CreateOrderResponse>(
        'POST',
        '/portfolio/orders',
        body as unknown as Record<string, unknown>
      );

      return this.parseOrder(response.order);
    });
  }

  async cancelOrder(orderId: string, _marketId?: string): Promise<Order> {
    this.ensureAuth();

    return this.withRetry(async () => {
      interface CancelOrderResponse {
        order: RawOrder;
      }

      const response = await this.request<CancelOrderResponse>(
        'DELETE',
        `/portfolio/orders/${orderId}`
      );

      return this.parseOrder(response.order);
    });
  }

  async fetchOrder(orderId: string, _marketId?: string): Promise<Order> {
    this.ensureAuth();

    return this.withRetry(async () => {
      interface OrderResponse {
        order: RawOrder;
      }

      const response = await this.request<OrderResponse>('GET', `/portfolio/orders/${orderId}`);
      return this.parseOrder(response.order);
    });
  }

  async fetchOpenOrders(marketId?: string): Promise<Order[]> {
    this.ensureAuth();

    return this.withRetry(async () => {
      interface OrdersResponse {
        orders: RawOrder[];
      }

      let endpoint = '/portfolio/orders?status=resting';
      if (marketId) {
        endpoint += `&ticker=${marketId}`;
      }

      const response = await this.request<OrdersResponse>('GET', endpoint);
      return (response.orders ?? []).map((o) => this.parseOrder(o));
    });
  }

  async fetchPositions(marketId?: string): Promise<Position[]> {
    this.ensureAuth();

    return this.withRetry(async () => {
      interface PositionsResponse {
        market_positions: RawPosition[];
      }

      let endpoint = '/portfolio/positions';
      if (marketId) {
        endpoint += `?ticker=${marketId}`;
      }

      const response = await this.request<PositionsResponse>('GET', endpoint);
      const positions = (response.market_positions ?? [])
        .map((p) => this.parsePosition(p))
        .filter((p) => p.size > 0);

      return positions;
    });
  }

  async fetchBalance(): Promise<Record<string, number>> {
    this.ensureAuth();

    return this.withRetry(async () => {
      interface BalanceResponse {
        balance: number;
        available_balance?: number;
      }

      const response = await this.request<BalanceResponse>('GET', '/portfolio/balance');

      // Kalshi balance is in cents, convert to dollars
      const balance = (response.available_balance ?? response.balance ?? 0) / 100;

      return { USD: balance };
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
