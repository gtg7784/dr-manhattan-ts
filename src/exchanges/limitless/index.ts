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

const BASE_URL = 'https://api.limitless.exchange';
const CHAIN_ID = 8453;

interface LimitlessConfig extends ExchangeConfig {
  host?: string;
  chainId?: number;
}

interface RawMarket {
  slug?: string;
  address?: string;
  title?: string;
  question?: string;
  description?: string;
  tokens?: { yes?: string; no?: string };
  yesPrice?: number;
  noPrice?: number;
  prices?: number[] | { yes?: number; no?: number };
  deadline?: string | number;
  closeDate?: string | number;
  expirationDate?: string | number;
  volume?: number;
  volumeFormatted?: number;
  liquidity?: number;
  liquidityFormatted?: number;
  status?: string;
  venue?: { exchange?: string };
  category?: string;
}

interface RawOrder {
  id?: string;
  orderId?: string;
  marketSlug?: string;
  market_id?: string;
  side?: number | string;
  status?: string;
  price?: number;
  size?: number;
  amount?: number;
  makerAmount?: number;
  takerAmount?: number;
  filled?: number;
  matchedAmount?: number;
  outcome?: string;
  token?: string;
  tokenId?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
}

interface RawPosition {
  market?: { slug?: string };
  marketSlug?: string;
  market_id?: string;
  tokensBalance?: { yes?: string | number; no?: string | number };
  positions?: {
    yes?: { fillPrice?: number };
    no?: { fillPrice?: number };
  };
  latestTrade?: {
    latestYesPrice?: number;
    latestNoPrice?: number;
  };
}

interface RawOrderbookLevel {
  price?: number | string;
  size?: number | string;
  side?: string;
}

export class Limitless extends Exchange {
  readonly id = 'limitless';
  readonly name = 'Limitless';

  private readonly host: string;
  private readonly chainId: number;
  private wallet: Wallet | null = null;
  private address: string | null = null;
  private authenticated = false;
  private ownerId: string | null = null;
  private sessionCookie: string | null = null;

  private tokenToSlug: Map<string, string> = new Map();
  private noTokens: Set<string> = new Set();

  constructor(config: LimitlessConfig = {}) {
    super(config);
    this.host = config.host ?? BASE_URL;
    this.chainId = config.chainId ?? CHAIN_ID;

    if (config.privateKey) {
      this.wallet = new Wallet(config.privateKey);
      this.address = this.wallet.address;
    }
  }

  private async authenticate(): Promise<void> {
    if (!this.wallet || !this.address) {
      throw new AuthenticationError('Private key required for authentication');
    }

    const msgResponse = await fetch(`${this.host}/auth/signing-message`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!msgResponse.ok) {
      throw new AuthenticationError('Failed to get signing message');
    }

    const message = await msgResponse.text();
    if (!message) {
      throw new AuthenticationError('Empty signing message');
    }

    const signature = await this.wallet.signMessage(message);
    const messageHex = `0x${Buffer.from(message, 'utf-8').toString('hex')}`;

    const loginResponse = await fetch(`${this.host}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-account': this.address,
        'x-signing-message': messageHex,
        'x-signature': signature,
      },
      body: JSON.stringify({ client: 'eoa' }),
    });

    if (!loginResponse.ok) {
      throw new AuthenticationError('Login failed');
    }

    const setCookie = loginResponse.headers.get('set-cookie');
    if (setCookie) {
      const match = /limitless_session=([^;]+)/.exec(setCookie);
      if (match?.[1]) {
        this.sessionCookie = match[1];
      }
    }

    const loginData = (await loginResponse.json()) as { user?: { id?: string }; id?: string };
    const userData = loginData.user ?? loginData;
    this.ownerId = userData.id ?? null;
    this.authenticated = true;
  }

  private async ensureAuth(): Promise<void> {
    if (!this.authenticated) {
      if (!this.wallet) {
        throw new AuthenticationError('Private key required for this operation');
      }
      await this.authenticate();
    }
  }

  private async request<T>(
    method: string,
    endpoint: string,
    params?: Record<string, unknown>,
    requireAuth = false
  ): Promise<T> {
    if (requireAuth) {
      await this.ensureAuth();
    }

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

    if (this.sessionCookie) {
      headers.Cookie = `limitless_session=${this.sessionCookie}`;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (method !== 'GET' && method !== 'DELETE' && params) {
      fetchOptions.body = JSON.stringify(params);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (!response.ok) {
      if (response.status === 429) {
        throw new NetworkError('Rate limited');
      }
      if (response.status === 401 || response.status === 403) {
        this.authenticated = false;
        throw new AuthenticationError('Authentication failed');
      }
      if (response.status === 404) {
        throw new ExchangeError(`Resource not found: ${endpoint}`);
      }
      throw new NetworkError(`HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private parseMarket(data: RawMarket): Market {
    const slug = data.slug ?? data.address ?? '';
    const question = data.title ?? data.question ?? '';

    const tokens = data.tokens ?? {};
    const yesTokenId = String(tokens.yes ?? '');
    const noTokenId = String(tokens.no ?? '');

    const outcomes = ['Yes', 'No'];
    const tokenIds = yesTokenId && noTokenId ? [yesTokenId, noTokenId] : [];

    const prices: Record<string, number> = {};
    if (data.yesPrice !== undefined) {
      const yesPrice = data.yesPrice ?? 0;
      const noPrice = data.noPrice ?? 0;
      prices.Yes = yesPrice > 1 ? yesPrice / 100 : yesPrice;
      prices.No = noPrice > 1 ? noPrice / 100 : noPrice;
    } else if (data.prices) {
      if (Array.isArray(data.prices)) {
        const yesPrice = data.prices[0] ?? 0;
        const noPrice = data.prices[1] ?? 0;
        prices.Yes = yesPrice > 1 ? yesPrice / 100 : yesPrice;
        prices.No = noPrice > 1 ? noPrice / 100 : noPrice;
      } else {
        const yesPrice = data.prices.yes ?? 0;
        const noPrice = data.prices.no ?? 0;
        prices.Yes = yesPrice > 1 ? yesPrice / 100 : yesPrice;
        prices.No = noPrice > 1 ? noPrice / 100 : noPrice;
      }
    }

    let closeTime: Date | undefined;
    const deadline = data.deadline ?? data.closeDate ?? data.expirationDate;
    if (deadline) {
      closeTime = this.parseDateTime(deadline);
    }

    const volume = data.volumeFormatted ?? data.volume ?? 0;
    const liquidity = data.liquidityFormatted ?? data.liquidity ?? 0;
    const tickSize = 0.001;

    for (const tokenId of tokenIds) {
      if (tokenId) {
        this.tokenToSlug.set(tokenId, slug);
      }
    }
    if (noTokenId) {
      this.noTokens.add(noTokenId);
    }

    const status = data.status ?? '';
    const closed = status.toLowerCase() === 'resolved' || status.toLowerCase() === 'closed';

    const metadata: Record<string, unknown> = {
      ...data,
      slug,
      clobTokenIds: tokenIds,
      token_ids: tokenIds,
      tokens: { Yes: yesTokenId, No: noTokenId },
      minimum_tick_size: tickSize,
      closed,
    };

    return {
      id: slug,
      question,
      outcomes,
      closeTime,
      volume,
      liquidity,
      prices,
      tickSize,
      description: data.description ?? '',
      metadata,
    };
  }

  private parseOrder(data: RawOrder, tokenToOutcome?: Map<string, string>): Order {
    const orderId = String(data.id ?? data.orderId ?? '');
    const marketId = data.marketSlug ?? data.market_id ?? '';

    let side: OrderSide;
    if (typeof data.side === 'number') {
      side = data.side === 0 ? OrderSide.BUY : OrderSide.SELL;
    } else {
      side = String(data.side).toLowerCase() === 'buy' ? OrderSide.BUY : OrderSide.SELL;
    }

    const status = this.parseOrderStatus(data.status);
    const price = data.price ?? 0;

    let size = data.size ?? data.amount ?? 0;
    if (!size) {
      const makerAmount = data.makerAmount ?? 0;
      const takerAmount = data.takerAmount ?? 0;
      if (makerAmount || takerAmount) {
        size = side === OrderSide.BUY ? takerAmount / 1_000_000 : makerAmount / 1_000_000;
      }
    }

    const filled = data.filled ?? data.matchedAmount ?? 0;

    let createdAt = new Date();
    if (data.createdAt) {
      const parsed = this.parseDateTime(data.createdAt);
      if (parsed) createdAt = parsed;
    }

    let outcome = data.outcome ?? '';
    if (!outcome && tokenToOutcome) {
      const tokenId = String(data.token ?? data.tokenId ?? '');
      outcome = tokenToOutcome.get(tokenId) ?? '';
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
    };
  }

  private parseOrderStatus(status: unknown): OrderStatus {
    if (!status) return OrderStatus.OPEN;

    const statusStr = String(status).toLowerCase();
    const statusMap: Record<string, OrderStatus> = {
      pending: OrderStatus.PENDING,
      open: OrderStatus.OPEN,
      live: OrderStatus.OPEN,
      active: OrderStatus.OPEN,
      filled: OrderStatus.FILLED,
      matched: OrderStatus.FILLED,
      partially_filled: OrderStatus.PARTIALLY_FILLED,
      partial: OrderStatus.PARTIALLY_FILLED,
      cancelled: OrderStatus.CANCELLED,
      canceled: OrderStatus.CANCELLED,
    };
    return statusMap[statusStr] ?? OrderStatus.OPEN;
  }

  private parsePortfolioPositions(data: RawPosition): Position[] {
    const positions: Position[] = [];

    const marketData = data.market ?? {};
    const marketId = marketData.slug ?? data.marketSlug ?? '';

    const tokensBalance = data.tokensBalance ?? {};
    const positionDetails = data.positions ?? {};
    const latestTrade = data.latestTrade ?? {};

    const yesBalance = Number(tokensBalance.yes ?? 0);
    if (yesBalance > 0) {
      const yesDetails = positionDetails.yes ?? {};
      const fillPrice = yesDetails.fillPrice ?? 0;
      const avgPrice = fillPrice > 1 ? fillPrice / 1_000_000 : fillPrice;
      const currentPrice = latestTrade.latestYesPrice ?? 0;
      const size = yesBalance / 1_000_000;

      positions.push({
        marketId,
        outcome: 'Yes',
        size,
        averagePrice: avgPrice,
        currentPrice,
      });
    }

    const noBalance = Number(tokensBalance.no ?? 0);
    if (noBalance > 0) {
      const noDetails = positionDetails.no ?? {};
      const fillPrice = noDetails.fillPrice ?? 0;
      const avgPrice = fillPrice > 1 ? fillPrice / 1_000_000 : fillPrice;
      const currentPrice = latestTrade.latestNoPrice ?? 0;
      const size = noBalance / 1_000_000;

      positions.push({
        marketId,
        outcome: 'No',
        size,
        averagePrice: avgPrice,
        currentPrice,
      });
    }

    return positions;
  }

  async fetchMarkets(params?: FetchMarketsParams): Promise<Market[]> {
    return this.withRetry(async () => {
      const queryParams: Record<string, unknown> = {
        page: params?.offset ? Math.floor(params.offset / 25) + 1 : 1,
        limit: Math.min(params?.limit ?? 25, 25),
      };

      const response = await this.request<{ data?: RawMarket[] } | RawMarket[]>(
        'GET',
        '/markets/active',
        queryParams
      );

      const marketsData = Array.isArray(response) ? response : (response.data ?? []);

      let markets = marketsData.map((m) => this.parseMarket(m));

      if (params?.active !== false) {
        markets = markets.filter((m) => !m.metadata?.closed);
      }

      if (params?.limit) {
        return markets.slice(0, params.limit);
      }
      return markets;
    });
  }

  async fetchMarket(marketId: string): Promise<Market> {
    return this.withRetry(async () => {
      try {
        const data = await this.request<RawMarket>('GET', `/markets/${marketId}`);
        return this.parseMarket(data);
      } catch (error) {
        if (error instanceof ExchangeError && error.message.includes('not found')) {
          throw new MarketNotFound(`Market ${marketId} not found`);
        }
        throw error;
      }
    });
  }

  async getOrderbook(marketSlugOrTokenId: string): Promise<{
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
  }> {
    const isNoToken = this.noTokens.has(marketSlugOrTokenId);
    const slug = this.tokenToSlug.get(marketSlugOrTokenId) ?? marketSlugOrTokenId;

    return this.withRetry(async () => {
      const response = await this.request<{
        orders?: RawOrderbookLevel[];
        data?: RawOrderbookLevel[];
        bids?: RawOrderbookLevel[];
        asks?: RawOrderbookLevel[];
      }>('GET', `/markets/${slug}/orderbook`);

      const bids: Array<{ price: string; size: string }> = [];
      const asks: Array<{ price: string; size: string }> = [];

      const orders = response.orders ?? response.data ?? [];
      for (const order of orders) {
        const side = String(order.side ?? '').toLowerCase();
        const price = Number(order.price ?? 0);
        const size = Number(order.size ?? 0);

        if (price > 0 && size > 0) {
          const entry = { price: String(price), size: String(size) };
          if (side === 'buy') {
            bids.push(entry);
          } else {
            asks.push(entry);
          }
        }
      }

      if (response.bids) {
        for (const bid of response.bids) {
          bids.push({
            price: String(bid.price ?? 0),
            size: String(bid.size ?? 0),
          });
        }
      }
      if (response.asks) {
        for (const ask of response.asks) {
          asks.push({
            price: String(ask.price ?? 0),
            size: String(ask.size ?? 0),
          });
        }
      }

      bids.sort((a, b) => Number(b.price) - Number(a.price));
      asks.sort((a, b) => Number(a.price) - Number(b.price));

      if (isNoToken) {
        const invertedBids = asks.map((a) => ({
          price: String(Math.round((1 - Number(a.price)) * 1000) / 1000),
          size: a.size,
        }));
        const invertedAsks = bids.map((b) => ({
          price: String(Math.round((1 - Number(b.price)) * 1000) / 1000),
          size: b.size,
        }));
        invertedBids.sort((a, b) => Number(b.price) - Number(a.price));
        invertedAsks.sort((a, b) => Number(a.price) - Number(b.price));
        return { bids: invertedBids, asks: invertedAsks };
      }

      return { bids, asks };
    });
  }

  async createOrder(params: CreateOrderParams): Promise<Order> {
    await this.ensureAuth();

    if (!this.wallet || !this.address) {
      throw new AuthenticationError('Wallet not initialized');
    }

    const market = await this.fetchMarket(params.marketId);
    const tokens = (market.metadata?.tokens ?? {}) as Record<string, string>;
    const tokenId = params.tokenId ?? tokens[params.outcome];

    if (!tokenId) {
      throw new InvalidOrder(`Could not find token_id for outcome '${params.outcome}'`);
    }

    if (params.price <= 0 || params.price >= 1) {
      throw new InvalidOrder(`Price must be between 0 and 1, got: ${params.price}`);
    }

    const venue = market.metadata?.venue as { exchange?: string } | undefined;
    const exchangeAddress = venue?.exchange;
    if (!exchangeAddress) {
      throw new InvalidOrder('Market does not have venue.exchange address');
    }

    const orderType = (params.params?.order_type as string)?.toUpperCase() ?? 'GTC';
    const feeRateBps = 300;

    const signedOrder = await this.buildSignedOrder(
      tokenId,
      params.price,
      params.size,
      params.side,
      orderType,
      exchangeAddress,
      feeRateBps
    );

    const payload: Record<string, unknown> = {
      order: signedOrder,
      orderType,
      marketSlug: params.marketId,
    };

    if (this.ownerId) {
      payload.ownerId = this.ownerId;
    }

    return this.withRetry(async () => {
      const result = await this.request<{ order?: RawOrder } | RawOrder>(
        'POST',
        '/orders',
        payload,
        true
      );

      const orderData = (result as { order?: RawOrder }).order ?? (result as RawOrder);
      const orderId = orderData.id ?? orderData.orderId ?? '';
      const statusStr = orderData.status ?? 'LIVE';

      return {
        id: String(orderId),
        marketId: params.marketId,
        outcome: params.outcome,
        side: params.side,
        price: params.price,
        size: params.size,
        filled: Number(orderData.filled ?? 0),
        status: this.parseOrderStatus(statusStr),
        createdAt: new Date(),
      };
    });
  }

  private async buildSignedOrder(
    tokenId: string,
    price: number,
    size: number,
    side: OrderSide,
    orderType: string,
    exchangeAddress: string,
    feeRateBps: number
  ): Promise<Record<string, unknown>> {
    if (!this.wallet || !this.address) {
      throw new AuthenticationError('Wallet not initialized');
    }

    const timestampMs = Date.now();
    const nanoOffset = Math.floor(Math.random() * 1_000_000);
    const oneDayMs = 1000 * 60 * 60 * 24;
    const salt = timestampMs * 1000 + nanoOffset + oneDayMs;

    const sharesScale = 1_000_000;
    const collateralScale = 1_000_000;
    const priceScale = 1_000_000;
    const priceTick = 0.001;

    let shares = Math.floor(size * sharesScale);
    const priceInt = Math.floor(price * priceScale);
    const tickInt = Math.floor(priceTick * priceScale);

    const sharesStep = Math.floor(priceScale / tickInt);
    if (shares % sharesStep !== 0) {
      shares = Math.floor(shares / sharesStep) * sharesStep;
    }

    const numerator = shares * priceInt * collateralScale;
    const denominator = sharesScale * priceScale;

    const sideInt = side === OrderSide.BUY ? 0 : 1;

    let makerAmount: number;
    let takerAmount: number;

    if (side === OrderSide.BUY) {
      const collateral = Math.ceil(numerator / denominator);
      makerAmount = collateral;
      takerAmount = shares;
    } else {
      const collateral = Math.floor(numerator / denominator);
      makerAmount = shares;
      takerAmount = collateral;
    }

    const orderForSigning = {
      salt,
      maker: this.address,
      signer: this.address,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId: Number.parseInt(tokenId, 10),
      makerAmount,
      takerAmount,
      expiration: 0,
      nonce: 0,
      feeRateBps,
      side: sideInt,
      signatureType: 0,
    };

    const signature = await this.signOrderEip712(orderForSigning, exchangeAddress);

    const order: Record<string, unknown> = {
      salt,
      maker: this.address,
      signer: this.address,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId,
      makerAmount,
      takerAmount,
      expiration: '0',
      nonce: 0,
      feeRateBps,
      side: sideInt,
      signatureType: 0,
      signature,
    };

    if (orderType === 'GTC') {
      order.price = Math.round(price * 1000) / 1000;
    }

    return order;
  }

  private async signOrderEip712(
    order: Record<string, unknown>,
    exchangeAddress: string
  ): Promise<string> {
    if (!this.wallet) {
      throw new AuthenticationError('Wallet not initialized');
    }

    const domain = {
      name: 'Limitless CTF Exchange',
      version: '1',
      chainId: this.chainId,
      verifyingContract: exchangeAddress,
    };

    const types = {
      Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
      ],
    };

    const value = {
      salt: order.salt,
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      expiration: order.expiration,
      nonce: order.nonce,
      feeRateBps: order.feeRateBps,
      side: order.side,
      signatureType: order.signatureType,
    };

    const signature = await (
      this.wallet as Wallet & {
        _signTypedData: (domain: unknown, types: unknown, value: unknown) => Promise<string>;
      }
    )._signTypedData(domain, types, value);
    return signature;
  }

  async cancelOrder(orderId: string, marketId?: string): Promise<Order> {
    await this.ensureAuth();

    return this.withRetry(async () => {
      await this.request('DELETE', `/orders/${orderId}`, undefined, true);

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
    await this.ensureAuth();

    return this.withRetry(async () => {
      const data = await this.request<RawOrder>('GET', `/orders/${orderId}`, undefined, true);
      return this.parseOrder(data);
    });
  }

  async fetchOpenOrders(marketId?: string): Promise<Order[]> {
    await this.ensureAuth();

    const queryParams: Record<string, unknown> = { statuses: 'LIVE' };
    let endpoint: string;

    if (marketId) {
      endpoint = `/markets/${marketId}/user-orders`;
    } else {
      endpoint = '/orders';
    }

    let tokenToOutcome: Map<string, string> | undefined;
    if (marketId) {
      try {
        const market = await this.fetchMarket(marketId);
        const tokens = (market.metadata?.tokens ?? {}) as Record<string, string>;
        tokenToOutcome = new Map();
        for (const [outcome, tokenId] of Object.entries(tokens)) {
          if (tokenId) {
            tokenToOutcome.set(tokenId, outcome);
          }
        }
      } catch {
        tokenToOutcome = undefined;
      }
    }

    return this.withRetry(async () => {
      const response = await this.request<{ data?: RawOrder[] } | RawOrder[]>(
        'GET',
        endpoint,
        queryParams,
        true
      );

      const ordersData = Array.isArray(response) ? response : (response.data ?? []);

      return ordersData.map((o) => this.parseOrder(o, tokenToOutcome));
    });
  }

  async fetchPositions(marketId?: string): Promise<Position[]> {
    await this.ensureAuth();

    return this.withRetry(async () => {
      const response = await this.request<{ clob?: RawPosition[] }>(
        'GET',
        '/portfolio/positions',
        undefined,
        true
      );

      const clobPositions = response.clob ?? [];
      const positions: Position[] = [];

      for (const posData of clobPositions) {
        const parsed = this.parsePortfolioPositions(posData);
        for (const pos of parsed) {
          if (marketId && pos.marketId !== marketId) {
            continue;
          }
          positions.push(pos);
        }
      }

      return positions;
    });
  }

  async fetchBalance(): Promise<Record<string, number>> {
    await this.ensureAuth();

    if (!this.address) {
      throw new AuthenticationError('Wallet address not available');
    }

    const usdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const baseRpc = 'https://mainnet.base.org';

    try {
      const data = `0x70a08231000000000000000000000000${this.address.slice(2).toLowerCase()}`;

      const response = await fetch(baseRpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to: usdcAddress, data }, 'latest'],
          id: 1,
        }),
      });

      const result = (await response.json()) as { result?: string };
      const balanceHex = result.result ?? '0x0';
      const balanceWei = Number.parseInt(balanceHex, 16);
      const usdcBalance = balanceWei / 10 ** 6;

      return { USDC: usdcBalance };
    } catch {
      try {
        const response = await this.request<{ balance?: number; allowance?: number }>(
          'GET',
          '/portfolio/trading/allowance',
          { type: 'clob' },
          true
        );
        const balance = response.balance ?? response.allowance ?? 0;
        return { USDC: balance };
      } catch {
        return { USDC: 0 };
      }
    }
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
        websocket: true,
      },
    };
  }
}

export {
  type LimitlessOrderbookUpdate,
  type LimitlessPositionUpdate,
  type LimitlessPriceUpdate,
  type LimitlessTrade,
  LimitlessUserWebSocket,
  LimitlessWebSocket,
  type LimitlessWsConfig,
} from './limitless-ws.js';
