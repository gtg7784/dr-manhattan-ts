/**
 * Predict.fun Exchange implementation for dr-manhattan.
 *
 * Predict.fun is a prediction market on BNB Chain with CLOB-style orderbook.
 * Uses REST API for communication and EIP-712 for order signing.
 *
 * API Documentation: https://dev.predict.fun/
 */

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

const BASE_URL = 'https://api.predict.fun';
const TESTNET_URL = 'https://api-testnet.predict.fun';

const CHAIN_ID = 56; // BNB Mainnet
const TESTNET_CHAIN_ID = 97; // BNB Testnet

// Yield-bearing CTFExchange contract addresses (default for most markets)
const YIELD_BEARING_CTF_EXCHANGE_MAINNET = '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5';
const YIELD_BEARING_CTF_EXCHANGE_TESTNET = '0x8a6B4Fa700A1e310b106E7a48bAFa29111f66e89';
const YIELD_BEARING_NEG_RISK_CTF_EXCHANGE_MAINNET = '0x8A289d458f5a134bA40015085A8F50Ffb681B41d';
const YIELD_BEARING_NEG_RISK_CTF_EXCHANGE_TESTNET = '0x95D5113bc50eD201e319101bbca3e0E250662fCC';

// Non-yield-bearing CTFExchange contract addresses
const CTF_EXCHANGE_MAINNET = '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689';
const CTF_EXCHANGE_TESTNET = '0x2A6413639BD3d73a20ed8C95F634Ce198ABbd2d7';
const NEG_RISK_CTF_EXCHANGE_MAINNET = '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A';
const NEG_RISK_CTF_EXCHANGE_TESTNET = '0xd690b2bd441bE36431F6F6639D7Ad351e7B29680';

// EIP-712 domain name (must match official SDK)
const PROTOCOL_NAME = 'predict.fun CTF Exchange';
const PROTOCOL_VERSION = '1';

export interface PredictFunConfig extends ExchangeConfig {
  /** Use testnet API */
  testnet?: boolean;
  /** Custom API host */
  host?: string;
}

interface RawMarket {
  id?: number | string;
  title?: string;
  question?: string;
  description?: string;
  outcomes?: Array<{ name?: string; onChainId?: string }>;
  status?: string;
  decimalPrecision?: number;
  isNegRisk?: boolean;
  isYieldBearing?: boolean;
  conditionId?: string;
  feeRateBps?: number;
  categorySlug?: string;
  volume?: number;
  liquidity?: number;
  [key: string]: unknown;
}

interface RawOrder {
  hash?: string;
  orderHash?: string;
  id?: string;
  marketId?: string | number;
  side?: string | number;
  status?: string;
  price?: string | number;
  pricePerShare?: string | number;
  amount?: string | number;
  amountFilled?: string | number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface RawPosition {
  marketId?: string | number;
  tokenId?: string;
  outcome?: string;
  size?: string | number;
  avgPrice?: string | number;
  currentPrice?: string | number;
  [key: string]: unknown;
}

export class PredictFun extends Exchange {
  readonly id = 'predictfun';
  readonly name = 'Predict.fun';

  private readonly host: string;
  private readonly chainId: number;
  private readonly testnet: boolean;
  private wallet: Wallet | null = null;
  private address: string | null = null;
  private jwtToken: string | null = null;
  private authenticated = false;

  // Contract addresses
  private readonly yieldBearingCtfExchange: string;
  private readonly yieldBearingNegRiskCtfExchange: string;
  private readonly ctfExchange: string;
  private readonly negRiskCtfExchange: string;

  constructor(config: PredictFunConfig = {}) {
    super(config);

    this.testnet = config.testnet ?? false;

    if (this.testnet) {
      this.host = config.host ?? TESTNET_URL;
      this.chainId = TESTNET_CHAIN_ID;
      this.yieldBearingCtfExchange = YIELD_BEARING_CTF_EXCHANGE_TESTNET;
      this.yieldBearingNegRiskCtfExchange = YIELD_BEARING_NEG_RISK_CTF_EXCHANGE_TESTNET;
      this.ctfExchange = CTF_EXCHANGE_TESTNET;
      this.negRiskCtfExchange = NEG_RISK_CTF_EXCHANGE_TESTNET;
    } else {
      this.host = config.host ?? BASE_URL;
      this.chainId = CHAIN_ID;
      this.yieldBearingCtfExchange = YIELD_BEARING_CTF_EXCHANGE_MAINNET;
      this.yieldBearingNegRiskCtfExchange = YIELD_BEARING_NEG_RISK_CTF_EXCHANGE_MAINNET;
      this.ctfExchange = CTF_EXCHANGE_MAINNET;
      this.negRiskCtfExchange = NEG_RISK_CTF_EXCHANGE_MAINNET;
    }

    if (config.privateKey) {
      this.wallet = new Wallet(config.privateKey);
      this.address = this.wallet.address;
    }
  }

  private getHeaders(requireAuth = false): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['x-api-key'] = this.config.apiKey;
    }

    if (requireAuth && this.jwtToken) {
      headers.Authorization = `Bearer ${this.jwtToken}`;
    }

    return headers;
  }

  private async authenticate(): Promise<void> {
    if (!this.config.apiKey) {
      throw new AuthenticationError('API key required for authentication');
    }
    if (!this.wallet || !this.address) {
      throw new AuthenticationError('Private key required for authentication');
    }

    // Get signing message
    const msgResponse = await fetch(`${this.host}/v1/auth/message`, {
      method: 'GET',
      headers: { 'x-api-key': this.config.apiKey },
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!msgResponse.ok) {
      throw new AuthenticationError('Failed to get signing message');
    }

    const msgData = (await msgResponse.json()) as { data?: { message?: string } };
    const message = msgData.data?.message;

    if (!message) {
      throw new AuthenticationError('Empty signing message');
    }

    // Sign the message using EIP-191 personal sign
    const signature = await this.wallet.signMessage(message);

    // Get JWT token
    const jwtResponse = await fetch(`${this.host}/v1/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
      },
      body: JSON.stringify({
        signer: this.address,
        message,
        signature,
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!jwtResponse.ok) {
      throw new AuthenticationError('JWT authentication failed');
    }

    const jwtData = (await jwtResponse.json()) as { data?: { token?: string } };
    this.jwtToken = jwtData.data?.token ?? null;

    if (!this.jwtToken) {
      throw new AuthenticationError('Failed to get JWT token');
    }

    this.authenticated = true;

    if (this.verbose) {
      console.log(`Authenticated as ${this.address}`);
    }
  }

  private async ensureAuth(): Promise<void> {
    if (!this.authenticated) {
      if (!this.wallet || !this.config.apiKey) {
        throw new AuthenticationError('API key and private key required for this operation');
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

    const headers = this.getHeaders(requireAuth);

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeout),
    };

    if (method !== 'GET' && method !== 'DELETE' && params) {
      fetchOptions.body = JSON.stringify(params);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (response.status === 429) {
      throw new NetworkError('Rate limited');
    }

    if (response.status === 401) {
      // Try to re-authenticate
      if (this.config.apiKey && this.wallet) {
        this.jwtToken = null;
        this.authenticated = false;
        await this.authenticate();

        // Retry the request
        const retryHeaders = this.getHeaders(requireAuth);
        const retryResponse = await fetch(url.toString(), {
          ...fetchOptions,
          headers: retryHeaders,
        });

        if (!retryResponse.ok) {
          throw new AuthenticationError('Authentication failed after retry');
        }

        return retryResponse.json() as Promise<T>;
      }
      throw new AuthenticationError('Authentication failed');
    }

    if (response.status === 403) {
      throw new AuthenticationError('Access forbidden');
    }

    if (response.status === 404) {
      throw new ExchangeError(`Resource not found: ${endpoint}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new NetworkError(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
    }

    return response.json() as Promise<T>;
  }

  private parseMarket(data: RawMarket): Market {
    const marketId = String(data.id ?? '');
    const title = data.title ?? '';
    const question = data.question ?? title;
    const description = data.description ?? '';

    const outcomesData = data.outcomes ?? [];
    const outcomes = outcomesData.map((o) => o.name ?? '').filter(Boolean);
    const tokenIds = outcomesData.map((o) => String(o.onChainId ?? '')).filter(Boolean);

    if (outcomes.length === 0) {
      outcomes.push('Yes', 'No');
    }

    const status = data.status ?? '';
    const closed = status === 'RESOLVED' || status === 'PAUSED';

    const decimalPrecision = data.decimalPrecision ?? 2;
    const tickSize = 10 ** -decimalPrecision;

    const prices: Record<string, number> = {};

    return {
      id: marketId,
      question,
      outcomes,
      closeTime: undefined,
      volume: data.volume ?? 0,
      liquidity: data.liquidity ?? 0,
      prices,
      tickSize,
      description,
      metadata: {
        ...data,
        clobTokenIds: tokenIds,
        token_ids: tokenIds,
        isNegRisk: data.isNegRisk ?? false,
        isYieldBearing: data.isYieldBearing ?? true,
        conditionId: data.conditionId ?? '',
        feeRateBps: data.feeRateBps ?? 0,
        categorySlug: data.categorySlug ?? '',
        closed,
        minimum_tick_size: tickSize,
      },
    };
  }

  private parseOrder(data: RawOrder, outcome?: string): Order {
    const orderId = String(data.hash ?? data.orderHash ?? data.id ?? '');
    const marketId = String(data.marketId ?? '');

    let side: OrderSide;
    if (typeof data.side === 'number') {
      side = data.side === 0 ? OrderSide.BUY : OrderSide.SELL;
    } else {
      side = String(data.side ?? 'buy').toLowerCase() === 'buy' ? OrderSide.BUY : OrderSide.SELL;
    }

    const status = this.parseOrderStatus(data.status);

    // Price from wei to decimal
    let price = 0;
    if (data.pricePerShare) {
      const priceWei = BigInt(String(data.pricePerShare));
      price = Number(priceWei) / 1e18;
    } else if (data.price) {
      price = Number(data.price);
    }

    const amount = Number(data.amount ?? 0);
    const filled = Number(data.amountFilled ?? 0);

    let createdAt = new Date();
    if (data.createdAt) {
      const parsed = this.parseDateTime(data.createdAt);
      if (parsed) createdAt = parsed;
    }

    let updatedAt: Date | undefined;
    if (data.updatedAt) {
      updatedAt = this.parseDateTime(data.updatedAt);
    }

    return {
      id: orderId,
      marketId,
      outcome: outcome ?? '',
      side,
      price,
      size: amount,
      filled,
      status,
      createdAt,
      updatedAt,
    };
  }

  private parseOrderStatus(status: unknown): OrderStatus {
    if (!status) return OrderStatus.OPEN;

    const statusStr = String(status).toUpperCase();
    const statusMap: Record<string, OrderStatus> = {
      PENDING: OrderStatus.PENDING,
      OPEN: OrderStatus.OPEN,
      LIVE: OrderStatus.OPEN,
      ACTIVE: OrderStatus.OPEN,
      FILLED: OrderStatus.FILLED,
      MATCHED: OrderStatus.FILLED,
      PARTIALLY_FILLED: OrderStatus.PARTIALLY_FILLED,
      CANCELLED: OrderStatus.CANCELLED,
      CANCELED: OrderStatus.CANCELLED,
      EXPIRED: OrderStatus.CANCELLED,
      INVALIDATED: OrderStatus.REJECTED,
    };
    return statusMap[statusStr] ?? OrderStatus.OPEN;
  }

  private parsePosition(data: RawPosition): Position {
    const marketId = String(data.marketId ?? '');
    const outcome = data.outcome ?? '';
    const size = Number(data.size ?? 0);
    const averagePrice = Number(data.avgPrice ?? 0);
    const currentPrice = Number(data.currentPrice ?? 0);

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
      const queryParams: Record<string, unknown> = {};

      if (params?.limit) {
        queryParams.first = params.limit;
      }

      const response = await this.request<{ data?: RawMarket[] } | RawMarket[]>(
        'GET',
        '/v1/markets',
        queryParams
      );

      const marketsData = Array.isArray(response) ? response : (response.data ?? []);
      let markets = marketsData.map((m) => this.parseMarket(m));

      if (params?.active !== false) {
        markets = markets.filter((m) => !m.metadata?.closed);
      }

      if (params?.limit) {
        markets = markets.slice(0, params.limit);
      }

      return markets;
    });
  }

  async fetchMarket(marketId: string): Promise<Market> {
    return this.withRetry(async () => {
      try {
        const response = await this.request<{ data?: RawMarket } | RawMarket>(
          'GET',
          `/v1/markets/${marketId}`
        );

        const marketData = (response as { data?: RawMarket }).data ?? (response as RawMarket);
        return this.parseMarket(marketData);
      } catch (error) {
        if (error instanceof ExchangeError && error.message.includes('not found')) {
          throw new MarketNotFound(`Market ${marketId} not found`);
        }
        throw error;
      }
    });
  }

  async getOrderbook(marketId: string): Promise<{
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
  }> {
    return this.withRetry(async () => {
      try {
        const response = await this.request<{
          data?: { bids?: Array<[number, number]>; asks?: Array<[number, number]> };
        }>('GET', `/v1/markets/${marketId}/orderbook`);

        const data = response.data ?? {};
        const rawBids = data.bids ?? [];
        const rawAsks = data.asks ?? [];

        const bids: Array<{ price: string; size: string }> = [];
        const asks: Array<{ price: string; size: string }> = [];

        for (const entry of rawBids) {
          if (entry.length >= 2) {
            bids.push({ price: String(entry[0]), size: String(entry[1]) });
          }
        }

        for (const entry of rawAsks) {
          if (entry.length >= 2) {
            asks.push({ price: String(entry[0]), size: String(entry[1]) });
          }
        }

        bids.sort((a, b) => Number(b.price) - Number(a.price));
        asks.sort((a, b) => Number(a.price) - Number(b.price));

        return { bids, asks };
      } catch {
        return { bids: [], asks: [] };
      }
    });
  }

  async fetchTokenIds(marketId: string): Promise<string[]> {
    const market = await this.fetchMarket(marketId);
    const tokenIds = (market.metadata.clobTokenIds as string[]) ?? [];
    if (tokenIds.length === 0) {
      throw new ExchangeError(`No token IDs found for market ${marketId}`);
    }
    return tokenIds;
  }

  async createOrder(params: CreateOrderParams): Promise<Order> {
    await this.ensureAuth();

    if (!this.wallet || !this.address) {
      throw new AuthenticationError('Wallet not initialized');
    }

    const market = await this.fetchMarket(params.marketId);
    const outcomes = market.outcomes;
    const tokenIds = (market.metadata.clobTokenIds as string[]) ?? [];

    let tokenId = params.tokenId ?? params.params?.token_id;

    if (!tokenId) {
      const outcomeIndex = outcomes.indexOf(params.outcome);
      if (outcomeIndex !== -1 && outcomeIndex < tokenIds.length) {
        tokenId = tokenIds[outcomeIndex];
      }
    }

    if (!tokenId) {
      throw new InvalidOrder(`Could not find token_id for outcome '${params.outcome}'`);
    }

    if (params.price <= 0 || params.price > 1) {
      throw new InvalidOrder(`Price must be between 0 and 1, got: ${params.price}`);
    }

    const feeRateBps = (market.metadata.feeRateBps as number) ?? 0;
    const isYieldBearing = (market.metadata.isYieldBearing as boolean) ?? true;
    const isNegRisk = (market.metadata.isNegRisk as boolean) ?? false;

    let exchangeAddress: string;
    if (isYieldBearing) {
      exchangeAddress = isNegRisk
        ? this.yieldBearingNegRiskCtfExchange
        : this.yieldBearingCtfExchange;
    } else {
      exchangeAddress = isNegRisk ? this.negRiskCtfExchange : this.ctfExchange;
    }

    const strategy = (params.params?.strategy as string)?.toUpperCase() ?? 'LIMIT';

    const signedOrder = await this.buildSignedOrder(
      String(tokenId),
      params.price,
      params.size,
      params.side,
      feeRateBps,
      exchangeAddress
    );

    // Price in wei (1e18)
    const pricePerShareWei = BigInt(Math.floor(params.price * 1e18));

    const payload = {
      data: {
        pricePerShare: pricePerShareWei.toString(),
        strategy,
        slippageBps: params.params?.slippageBps ?? '0',
        order: signedOrder,
      },
    };

    return this.withRetry(async () => {
      const result = await this.request<{ data?: RawOrder } | RawOrder>(
        'POST',
        '/v1/orders',
        payload,
        true
      );

      const orderData = (result as { data?: RawOrder }).data ?? (result as RawOrder);
      const orderId = orderData.hash ?? orderData.orderHash ?? '';

      return {
        id: String(orderId),
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

  private async buildSignedOrder(
    tokenId: string,
    price: number,
    size: number,
    side: OrderSide,
    feeRateBps: number,
    exchangeAddress: string
  ): Promise<Record<string, unknown>> {
    if (!this.wallet || !this.address) {
      throw new AuthenticationError('Wallet not initialized');
    }

    // Generate salt
    const salt = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1_000_000));

    // Calculate amounts (all in wei, 18 decimals)
    const sharesWei = BigInt(Math.floor(size * 1e18));
    const priceWei = BigInt(Math.floor(price * 1e18));

    // side: 0 = BUY, 1 = SELL
    const sideInt = side === OrderSide.BUY ? 0 : 1;

    let makerAmount: bigint;
    let takerAmount: bigint;

    if (side === OrderSide.BUY) {
      // BUY: maker provides collateral, receives shares
      makerAmount = (sharesWei * priceWei) / BigInt(1e18);
      takerAmount = sharesWei;
    } else {
      // SELL: maker provides shares, receives collateral
      makerAmount = sharesWei;
      takerAmount = (sharesWei * priceWei) / BigInt(1e18);
    }

    const order = {
      salt: salt.toString(),
      maker: this.address,
      signer: this.address,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: '0',
      nonce: '0',
      feeRateBps: String(feeRateBps),
      side: sideInt,
      signatureType: 0,
    };

    // Sign with EIP-712
    const signature = await this.signOrderEip712(order, exchangeAddress);

    return {
      ...order,
      signature,
    };
  }

  private async signOrderEip712(
    order: Record<string, unknown>,
    exchangeAddress: string
  ): Promise<string> {
    if (!this.wallet) {
      throw new AuthenticationError('Wallet not initialized');
    }

    const domain = {
      name: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
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
      salt: BigInt(order.salt as string),
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: BigInt(order.tokenId as string),
      makerAmount: BigInt(order.makerAmount as string),
      takerAmount: BigInt(order.takerAmount as string),
      expiration: BigInt(order.expiration as string),
      nonce: BigInt(order.nonce as string),
      feeRateBps: BigInt(order.feeRateBps as string),
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
      await this.request(
        'DELETE',
        '/v1/orders',
        {
          orderHashes: [orderId],
        },
        true
      );

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
      const response = await this.request<{ data?: RawOrder } | RawOrder>(
        'GET',
        `/v1/orders/${orderId}`,
        undefined,
        true
      );

      const orderData = (response as { data?: RawOrder }).data ?? (response as RawOrder);
      return this.parseOrder(orderData);
    });
  }

  async fetchOpenOrders(marketId?: string): Promise<Order[]> {
    await this.ensureAuth();

    const queryParams: Record<string, unknown> = { status: 'OPEN' };
    if (marketId) {
      queryParams.marketId = marketId;
    }

    return this.withRetry(async () => {
      const response = await this.request<{ data?: RawOrder[] } | RawOrder[]>(
        'GET',
        '/v1/orders',
        queryParams,
        true
      );

      const ordersData = Array.isArray(response) ? response : (response.data ?? []);
      return ordersData.map((o) => this.parseOrder(o));
    });
  }

  async fetchPositions(marketId?: string): Promise<Position[]> {
    await this.ensureAuth();

    const queryParams: Record<string, unknown> = {};
    if (marketId) {
      queryParams.marketId = marketId;
    }

    return this.withRetry(async () => {
      const response = await this.request<{ data?: RawPosition[] } | RawPosition[]>(
        'GET',
        '/v1/positions',
        queryParams,
        true
      );

      const positionsData = Array.isArray(response) ? response : (response.data ?? []);
      return positionsData.map((p) => this.parsePosition(p)).filter((p) => p.size > 0);
    });
  }

  async fetchBalance(): Promise<Record<string, number>> {
    await this.ensureAuth();

    return this.withRetry(async () => {
      const response = await this.request<{
        data?: { balance?: string | number; availableBalance?: string | number };
      }>('GET', '/v1/balance', undefined, true);

      const data = response.data ?? {};
      const balance = Number(data.availableBalance ?? data.balance ?? 0);

      // Convert from wei to USDT (assuming 18 decimals)
      const balanceUsdt = balance / 1e18;

      return { USDT: balanceUsdt };
    });
  }

  get walletAddress(): string | null {
    return this.address;
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
