/**
 * Comprehensive Spread Strategy Example
 *
 * Usage:
 *   EXCHANGE=polymarket PRIVATE_KEY=0x... npx tsx examples/spread-strategy-comprehensive.ts
 *   EXCHANGE=limitless PRIVATE_KEY=0x... npx tsx examples/spread-strategy-comprehensive.ts
 *   EXCHANGE=kalshi KALSHI_API_KEY_ID=... KALSHI_PRIVATE_KEY_PATH=... npx tsx examples/spread-strategy-comprehensive.ts
 *   EXCHANGE=opinion OPINION_API_KEY=... PRIVATE_KEY=0x... MULTI_SIG_ADDR=... npx tsx examples/spread-strategy-comprehensive.ts
 *   EXCHANGE=predictfun PREDICTFUN_API_KEY=... PRIVATE_KEY=0x... npx tsx examples/spread-strategy-comprehensive.ts
 */

import {
  createExchange,
  Kalshi,
  Limitless,
  LimitlessWebSocket,
  listExchanges,
  type Market,
  MarketUtils,
  type Orderbook,
  OrderbookUtils,
  OrderSide,
  Polymarket,
  PolymarketWebSocket,
  PredictFun,
  Strategy,
  type StrategyConfig,
} from '../src/index.js';
import type { Exchange } from '../src/core/exchange.js';

interface SpreadStrategyConfig extends StrategyConfig {
  targetSpreadBps?: number;
  orderSizeUsd?: number;
  maxInventory?: number;
  skewFactor?: number;
  useWebSocket?: boolean;
  restPollingInterval?: number;
}

interface OrderbookProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  getOrderbook(): Orderbook | null;
}

class PolymarketOrderbookProvider implements OrderbookProvider {
  private ws: PolymarketWebSocket;
  private orderbook: Orderbook | null = null;
  private tokenId: string;
  private marketId: string;
  private verbose: boolean;

  constructor(tokenId: string, marketId: string, verbose = false) {
    this.tokenId = tokenId;
    this.marketId = marketId;
    this.verbose = verbose;
    this.ws = new PolymarketWebSocket({ verbose });
  }

  async start(): Promise<void> {
    this.ws.on('error', (err) => {
      if (this.verbose) console.error('[Polymarket WS] Error:', err.message);
    });

    await this.ws.watchOrderbookWithAsset(this.tokenId, this.tokenId, (_marketId, update) => {
      this.orderbook = {
        bids: update.bids,
        asks: update.asks,
        timestamp: update.timestamp,
        assetId: this.tokenId,
        marketId: this.marketId,
      };
    });

    if (this.verbose) console.log('[Polymarket WS] Connected and subscribed');
  }

  async stop(): Promise<void> {
    await this.ws.disconnect();
  }

  getOrderbook(): Orderbook | null {
    return this.orderbook;
  }
}

class LimitlessOrderbookProvider implements OrderbookProvider {
  private ws: LimitlessWebSocket;
  private orderbook: Orderbook | null = null;
  private marketSlug: string;
  private tokenIds: string[];
  private verbose: boolean;

  constructor(marketSlug: string, tokenIds: string[], verbose = false) {
    this.marketSlug = marketSlug;
    this.tokenIds = tokenIds;
    this.verbose = verbose;
    this.ws = new LimitlessWebSocket({ verbose });
  }

  async start(): Promise<void> {
    this.ws.on('error', (err) => {
      if (this.verbose) console.error('[Limitless WS] Error:', err);
    });

    await this.ws.watchOrderbookByMarket(this.marketSlug, this.tokenIds, (_marketId, update) => {
      this.orderbook = {
        bids: update.bids,
        asks: update.asks,
        timestamp: update.timestamp,
        assetId: this.tokenIds[0] ?? '',
        marketId: this.marketSlug,
      };
    });

    if (this.verbose) console.log('[Limitless WS] Connected and subscribed');
  }

  async stop(): Promise<void> {
    await this.ws.disconnect();
  }

  getOrderbook(): Orderbook | null {
    return this.orderbook;
  }
}

type OrderbookFetcher = () => Promise<Orderbook>;

class RestOrderbookProvider implements OrderbookProvider {
  private orderbook: Orderbook | null = null;
  private fetcher: OrderbookFetcher;
  private pollInterval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private verbose: boolean;
  private exchangeName: string;

  constructor(
    exchangeName: string,
    fetcher: OrderbookFetcher,
    pollInterval = 2000,
    verbose = false
  ) {
    this.exchangeName = exchangeName;
    this.fetcher = fetcher;
    this.pollInterval = pollInterval;
    this.verbose = verbose;
  }

  async start(): Promise<void> {
    await this.fetchOrderbook();

    this.timer = setInterval(async () => {
      await this.fetchOrderbook();
    }, this.pollInterval);

    if (this.verbose) {
      console.log(`[${this.exchangeName} REST] Started polling every ${this.pollInterval}ms`);
    }
  }

  private async fetchOrderbook(): Promise<void> {
    try {
      this.orderbook = await this.fetcher();
    } catch (error) {
      if (this.verbose) {
        console.error(`[${this.exchangeName} REST] Fetch error:`, error);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getOrderbook(): Orderbook | null {
    return this.orderbook;
  }
}

class ComprehensiveSpreadStrategy extends Strategy {
  private orderbookProvider: OrderbookProvider | null = null;
  private tokenId: string | null = null;
  private spreadConfig: SpreadStrategyConfig;

  constructor(exchange: Exchange, marketId: string, config: SpreadStrategyConfig = {}) {
    super(exchange, marketId, config);
    this.spreadConfig = {
      targetSpreadBps: 200,
      orderSizeUsd: 10,
      maxInventory: 100,
      skewFactor: 0.1,
      tickInterval: 5000,
      verbose: true,
      useWebSocket: true,
      restPollingInterval: 2000,
      ...config,
    };
  }

  async start(): Promise<void> {
    this.market = await this.exchange.fetchMarket(this.marketId);
    if (!this.market) {
      throw new Error(`Market ${this.marketId} not found`);
    }

    const tokenIds = MarketUtils.getTokenIds(this.market);
    if (tokenIds.length === 0) {
      throw new Error('No token IDs found for market');
    }
    this.tokenId = tokenIds[0] ?? null;

    await this.setupOrderbookProvider();

    await super.start();
    this.log(`Started spread strategy on ${this.market.question}`);
    this.log(`Exchange: ${this.exchange.id}`);
  }

  async stop(): Promise<void> {
    await super.stop();
    if (this.orderbookProvider) {
      await this.orderbookProvider.stop();
      this.orderbookProvider = null;
    }
    this.log('Stopped spread strategy');
  }

  private async setupOrderbookProvider(): Promise<void> {
    if (!this.market || !this.tokenId) return;

    const tokenIds = MarketUtils.getTokenIds(this.market);
    const useWs = this.spreadConfig.useWebSocket ?? true;
    const pollInterval = this.spreadConfig.restPollingInterval ?? 2000;
    const verbose = this.spreadConfig.verbose ?? false;

    switch (this.exchange.id) {
      case 'polymarket': {
        if (useWs) {
          this.orderbookProvider = new PolymarketOrderbookProvider(
            this.tokenId,
            this.marketId,
            verbose
          );
        } else {
          const polymarket = this.exchange as Polymarket;
          const tokenId = this.tokenId;
          this.orderbookProvider = new RestOrderbookProvider(
            'Polymarket',
            async () => {
              const data = await polymarket.getOrderbook(tokenId);
              return OrderbookUtils.fromRestResponse(data, tokenId);
            },
            pollInterval,
            verbose
          );
        }
        break;
      }

      case 'limitless': {
        if (useWs) {
          this.orderbookProvider = new LimitlessOrderbookProvider(this.marketId, tokenIds, verbose);
        } else {
          const limitless = this.exchange as Limitless;
          const marketId = this.marketId;
          const tokenId = this.tokenId;
          this.orderbookProvider = new RestOrderbookProvider(
            'Limitless',
            async () => {
              const data = await limitless.getOrderbook(marketId);
              return OrderbookUtils.fromRestResponse(data, tokenId);
            },
            pollInterval,
            verbose
          );
        }
        break;
      }

      case 'kalshi': {
        const kalshi = this.exchange as Kalshi;
        const marketId = this.marketId;
        this.orderbookProvider = new RestOrderbookProvider(
          'Kalshi',
          async () => kalshi.fetchOrderbook(marketId),
          pollInterval,
          verbose
        );
        break;
      }

      case 'opinion': {
        const opinion = this.exchange as unknown as {
          getOrderbook: (tokenId: string) => Promise<{
            bids: Array<{ price: string; size: string }>;
            asks: Array<{ price: string; size: string }>;
          }>;
        };
        const tokenId = this.tokenId;
        this.orderbookProvider = new RestOrderbookProvider(
          'Opinion',
          async () => {
            const data = await opinion.getOrderbook(tokenId);
            return OrderbookUtils.fromRestResponse(data, tokenId);
          },
          pollInterval,
          verbose
        );
        break;
      }

      case 'predictfun': {
        const predictfun = this.exchange as PredictFun;
        const marketId = this.marketId;
        const tokenId = this.tokenId;
        this.orderbookProvider = new RestOrderbookProvider(
          'PredictFun',
          async () => {
            const data = await predictfun.getOrderbook(marketId);
            return OrderbookUtils.fromRestResponse(data, tokenId);
          },
          pollInterval,
          verbose
        );
        break;
      }

      default:
        throw new Error(`Unsupported exchange: ${this.exchange.id}`);
    }

    await this.orderbookProvider.start();
  }

  async onTick(): Promise<void> {
    if (!this.market) {
      this.log('Waiting for market data...');
      return;
    }

    const orderbook = this.orderbookProvider?.getOrderbook();
    if (!orderbook) {
      this.log('Waiting for orderbook data...');
      return;
    }

    const bestBid = OrderbookUtils.bestBid(orderbook);
    const bestAsk = OrderbookUtils.bestAsk(orderbook);
    const mid = OrderbookUtils.midPrice(orderbook);
    const spread = OrderbookUtils.spread(orderbook);

    if (mid === null) {
      this.log('No mid price available');
      return;
    }

    this.logStatus(bestBid, bestAsk, mid, spread);

    const {
      targetSpreadBps = 200,
      orderSizeUsd = 10,
      maxInventory = 100,
      skewFactor = 0.1,
    } = this.spreadConfig;
    const targetSpread = targetSpreadBps / 10000;
    const halfSpread = targetSpread / 2;

    const netPosition = this.getNetPosition();
    const inventorySkew = (netPosition / maxInventory) * skewFactor;

    const bidPrice = Math.max(0.01, mid - halfSpread - inventorySkew);
    const askPrice = Math.min(0.99, mid + halfSpread - inventorySkew);

    const bidSize = Math.round(orderSizeUsd / bidPrice);
    const askSize = Math.round(orderSizeUsd / askPrice);

    this.log(
      `Quoting: Bid ${bidPrice.toFixed(3)} x ${bidSize} | Ask ${askPrice.toFixed(3)} x ${askSize}`
    );
    this.log(`Inventory: ${netPosition} (skew: ${inventorySkew.toFixed(4)})`);

    await this.cancelAllOrders();

    const outcome = this.market.outcomes[0];
    if (!outcome || !this.tokenId) return;

    if (netPosition < maxInventory) {
      await this.placeOrder(outcome, OrderSide.BUY, bidPrice, bidSize, this.tokenId);
    }

    if (netPosition > -maxInventory) {
      await this.placeOrder(outcome, OrderSide.SELL, askPrice, askSize, this.tokenId);
    }
  }

  private logStatus(
    bid: number | null,
    ask: number | null,
    mid: number | null,
    spread: number | null
  ): void {
    const bidStr = bid?.toFixed(3) ?? 'N/A';
    const askStr = ask?.toFixed(3) ?? 'N/A';
    const midStr = mid?.toFixed(3) ?? 'N/A';
    const spreadBps = spread ? (spread * 10000).toFixed(0) : 'N/A';
    this.log(`Market: Bid ${bidStr} | Ask ${askStr} | Mid ${midStr} | Spread ${spreadBps}bps`);
  }
}

interface ExchangeCreationResult {
  exchange: Exchange;
  requiresAuth: boolean;
}

function createExchangeWithConfig(exchangeId: string): ExchangeCreationResult {
  switch (exchangeId.toLowerCase()) {
    case 'polymarket':
      return {
        exchange: new Polymarket({
          privateKey: process.env.PRIVATE_KEY,
          verbose: true,
        }),
        requiresAuth: !!process.env.PRIVATE_KEY,
      };

    case 'limitless':
      return {
        exchange: new Limitless({
          privateKey: process.env.PRIVATE_KEY,
          verbose: true,
        }),
        requiresAuth: !!process.env.PRIVATE_KEY,
      };

    case 'kalshi':
      return {
        exchange: new Kalshi({
          apiKeyId: process.env.KALSHI_API_KEY_ID,
          privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
          privateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM,
          demo: process.env.KALSHI_DEMO === 'true',
          verbose: true,
        }),
        requiresAuth: !!process.env.KALSHI_API_KEY_ID,
      };

    case 'opinion':
      return {
        exchange: createExchange('opinion', {
          apiKey: process.env.OPINION_API_KEY,
          privateKey: process.env.PRIVATE_KEY,
          verbose: true,
        }),
        requiresAuth: !!process.env.OPINION_API_KEY && !!process.env.PRIVATE_KEY,
      };

    case 'predictfun':
      return {
        exchange: new PredictFun({
          apiKey: process.env.PREDICTFUN_API_KEY,
          privateKey: process.env.PRIVATE_KEY,
          testnet: process.env.PREDICTFUN_TESTNET === 'true',
          verbose: true,
        }),
        requiresAuth: !!process.env.PREDICTFUN_API_KEY && !!process.env.PRIVATE_KEY,
      };

    default:
      throw new Error(`Unknown exchange: ${exchangeId}. Available: ${listExchanges().join(', ')}`);
  }
}

async function main() {
  const exchangeId = process.env.EXCHANGE ?? 'polymarket';

  console.log('='.repeat(60));
  console.log('Comprehensive Spread Strategy');
  console.log('='.repeat(60));
  console.log(`Exchange: ${exchangeId}`);
  console.log(`Available exchanges: ${listExchanges().join(', ')}`);
  console.log('');

  const { exchange, requiresAuth } = createExchangeWithConfig(exchangeId);

  if (!requiresAuth) {
    console.log('Running in SIMULATION mode (no credentials provided)');
    console.log('Orders will NOT be executed.\n');
  } else {
    console.log('Running in LIVE mode (credentials provided)');
    console.log('Orders WILL be executed!\n');
  }

  console.log('Finding a suitable market...');
  let market: Market | null = null;

  try {
    market = await exchange.findTradeableMarket({
      binary: true,
      minLiquidity: 1000,
    });
  } catch (error) {
    console.error('Error finding market:', error);
  }

  if (!market) {
    try {
      market = await exchange.findTradeableMarket({
        binary: true,
        minLiquidity: 0,
      });
    } catch (error) {
      console.error('Error finding market with no liquidity requirement:', error);
    }
  }

  if (!market) {
    console.error('No suitable market found');
    process.exit(1);
  }

  console.log(`\nSelected market: ${market.question}`);
  console.log(`  ID: ${market.id}`);
  console.log(`  Volume: $${market.volume.toLocaleString()}`);
  console.log(`  Liquidity: $${market.liquidity.toLocaleString()}`);
  console.log(`  Outcomes: ${market.outcomes.join(', ')}`);
  console.log('');

  const strategy = new ComprehensiveSpreadStrategy(exchange, market.id, {
    targetSpreadBps: 200,
    orderSizeUsd: 10,
    maxInventory: 100,
    tickInterval: 5000,
    verbose: true,
    useWebSocket: true,
    restPollingInterval: 2000,
  });

  strategy.on('order', (order) => {
    console.log(`[ORDER] ${order.side} ${order.size} @ ${order.price}`);
  });

  strategy.on('error', (error) => {
    console.error('[ERROR]', error);
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await strategy.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    await strategy.stop();
    process.exit(0);
  });

  console.log('Starting strategy...\n');
  await strategy.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
