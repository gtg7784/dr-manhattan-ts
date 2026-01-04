/**
 * Spike Strategy Example - Mean Reversion for Prediction Markets
 *
 * Detects price spikes (sudden drops) and buys the dip expecting bounce back.
 * BUY-only strategy: YES dip -> BUY YES, NO dip -> BUY NO.
 *
 * Usage:
 *   EXCHANGE=polymarket PRIVATE_KEY=0x... npx tsx examples/spike-strategy.ts
 *   EXCHANGE=polymarket PRIVATE_KEY=0x... npx tsx examples/spike-strategy.ts --spike-threshold 0.02
 *   EXCHANGE=kalshi KALSHI_API_KEY_ID=... KALSHI_PRIVATE_KEY_PATH=... npx tsx examples/spike-strategy.ts
 */

import type { Exchange } from '../src/core/exchange.js';
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

interface SpikeStrategyConfig extends StrategyConfig {
  /** Spike threshold - minimum deviation from EMA to trigger buy (default: 0.015 = 1.5%) */
  spikeThreshold?: number;
  /** Take profit target as ratio (default: 0.03 = 3%) */
  profitTarget?: number;
  /** Stop loss limit as ratio (default: 0.02 = 2%) */
  stopLoss?: number;
  /** Position size in USD per trade (default: 5) */
  positionSize?: number;
  /** EMA period in ticks (default: 30) */
  emaPeriod?: number;
  /** Cooldown after exit before re-entry in ms (default: 30000 = 30s) */
  cooldownMs?: number;
  /** Use WebSocket for orderbook (default: true for supported exchanges) */
  useWebSocket?: boolean;
  /** REST polling interval in ms when not using WebSocket (default: 2000) */
  restPollingInterval?: number;
}

interface EntryPosition {
  entryPrice: number;
  size: number;
  entryTime: number;
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

class SpikeStrategy extends Strategy {
  private orderbookProvider: OrderbookProvider | null = null;
  private spikeConfig: Required<
    Pick<
      SpikeStrategyConfig,
      | 'spikeThreshold'
      | 'profitTarget'
      | 'stopLoss'
      | 'positionSize'
      | 'emaPeriod'
      | 'cooldownMs'
      | 'useWebSocket'
      | 'restPollingInterval'
    >
  >;

  private tokenIds: Map<string, string> = new Map();
  private emaPrices: Map<string, number> = new Map();
  private emaAlpha: number;
  private priceHistory: Map<string, number[]> = new Map();
  private readonly priceHistoryMaxLen = 60;
  private entries: Map<string, EntryPosition> = new Map();
  private lastExitTime: Map<string, number> = new Map();

  constructor(exchange: Exchange, marketId: string, config: SpikeStrategyConfig = {}) {
    super(exchange, marketId, config);

    this.spikeConfig = {
      spikeThreshold: config.spikeThreshold ?? 0.015,
      profitTarget: config.profitTarget ?? 0.03,
      stopLoss: config.stopLoss ?? 0.02,
      positionSize: config.positionSize ?? 5,
      emaPeriod: config.emaPeriod ?? 30,
      cooldownMs: config.cooldownMs ?? 30000,
      useWebSocket: config.useWebSocket ?? true,
      restPollingInterval: config.restPollingInterval ?? 2000,
    };

    this.emaAlpha = 2.0 / (this.spikeConfig.emaPeriod + 1);
  }

  async start(): Promise<void> {
    this.market = await this.exchange.fetchMarket(this.marketId);
    if (!this.market) {
      throw new Error(`Market ${this.marketId} not found`);
    }

    for (const outcome of this.market.outcomes) {
      this.emaPrices.set(outcome, 0);
      this.priceHistory.set(outcome, []);
      this.lastExitTime.set(outcome, 0);
    }

    const tokens = MarketUtils.getTokenIds(this.market);
    this.market.outcomes.forEach((outcome, i) => {
      if (tokens[i]) {
        this.tokenIds.set(outcome, tokens[i]);
      }
    });

    await this.setupOrderbookProvider();

    await super.start();

    this.logConfig();
    this.log(`Started spike strategy on "${this.market.question}"`);
  }

  async stop(): Promise<void> {
    this.log('Shutting down spike strategy...');

    await this.cancelAllOrders();
    await this.closeAllPositions();

    if (this.orderbookProvider) {
      await this.orderbookProvider.stop();
      this.orderbookProvider = null;
    }

    await super.stop();
    this.log('Spike strategy stopped');
  }

  private logConfig(): void {
    const { spikeThreshold, profitTarget, stopLoss, positionSize, emaPeriod, cooldownMs } =
      this.spikeConfig;

    console.log(`\n${'='.repeat(50)}`);
    console.log('Spike Strategy Configuration');
    console.log('='.repeat(50));
    console.log(`  Threshold: ${(spikeThreshold * 100).toFixed(1)}%`);
    console.log(`  Take Profit: ${(profitTarget * 100).toFixed(1)}%`);
    console.log(`  Stop Loss: ${(stopLoss * 100).toFixed(1)}%`);
    console.log(`  Position Size: $${positionSize}`);
    console.log(`  EMA Period: ${emaPeriod} ticks`);
    console.log(`  Cooldown: ${cooldownMs / 1000}s`);
    console.log(`${'='.repeat(50)}\n`);
  }

  private async setupOrderbookProvider(): Promise<void> {
    if (!this.market) return;

    const tokenIds = MarketUtils.getTokenIds(this.market);
    const firstTokenId = tokenIds[0];
    if (!firstTokenId) {
      throw new Error('No token IDs found for market');
    }

    const useWs = this.spikeConfig.useWebSocket;
    const pollInterval = this.spikeConfig.restPollingInterval;
    const verbose = this.config.verbose ?? false;

    switch (this.exchange.id) {
      case 'polymarket': {
        if (useWs) {
          this.orderbookProvider = new PolymarketOrderbookProvider(
            firstTokenId,
            this.marketId,
            verbose
          );
        } else {
          const polymarket = this.exchange as Polymarket;
          this.orderbookProvider = new RestOrderbookProvider(
            'Polymarket',
            async () => {
              const data = await polymarket.getOrderbook(firstTokenId);
              return OrderbookUtils.fromRestResponse(data, firstTokenId);
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
          this.orderbookProvider = new RestOrderbookProvider(
            'Limitless',
            async () => {
              const data = await limitless.getOrderbook(this.marketId);
              return OrderbookUtils.fromRestResponse(data, firstTokenId);
            },
            pollInterval,
            verbose
          );
        }
        break;
      }

      case 'kalshi': {
        const kalshi = this.exchange as Kalshi;
        this.orderbookProvider = new RestOrderbookProvider(
          'Kalshi',
          async () => kalshi.fetchOrderbook(this.marketId),
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
        this.orderbookProvider = new RestOrderbookProvider(
          'Opinion',
          async () => {
            const data = await opinion.getOrderbook(firstTokenId);
            return OrderbookUtils.fromRestResponse(data, firstTokenId);
          },
          pollInterval,
          verbose
        );
        break;
      }

      case 'predictfun': {
        const predictfun = this.exchange as PredictFun;
        this.orderbookProvider = new RestOrderbookProvider(
          'PredictFun',
          async () => {
            const data = await predictfun.getOrderbook(this.marketId);
            return OrderbookUtils.fromRestResponse(data, firstTokenId);
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

    for (const outcome of this.market.outcomes) {
      const tokenId = this.tokenIds.get(outcome);
      if (!tokenId) continue;

      const price = this.getMidPrice(orderbook);
      if (price === null || price <= 0) continue;

      this.updateEma(outcome, price);
      this.updatePriceHistory(outcome, price);

      const position = this.getPosition(outcome);
      const positionSize = position?.size ?? 0;
      const entry = this.entries.get(outcome);

      if (entry) {
        await this.managePosition(outcome, price, positionSize, tokenId, entry);
      } else {
        await this.checkSpikeAndBuy(outcome, price, tokenId, orderbook);
      }
    }

    this.logStatus();
  }

  private getMidPrice(orderbook: Orderbook): number | null {
    const bid = OrderbookUtils.bestBid(orderbook);
    const ask = OrderbookUtils.bestAsk(orderbook);

    if (bid === null || ask === null || bid <= 0 || ask <= 0) {
      return null;
    }

    return (bid + ask) / 2;
  }

  private updateEma(outcome: string, price: number): void {
    const currentEma = this.emaPrices.get(outcome) ?? 0;

    if (currentEma === 0) {
      this.emaPrices.set(outcome, price);
    } else {
      // EMA = price * alpha + prev_ema * (1 - alpha)
      const newEma = price * this.emaAlpha + currentEma * (1 - this.emaAlpha);
      this.emaPrices.set(outcome, newEma);
    }
  }

  private updatePriceHistory(outcome: string, price: number): void {
    const history = this.priceHistory.get(outcome) ?? [];
    history.push(price);

    if (history.length > this.priceHistoryMaxLen) {
      history.shift();
    }

    this.priceHistory.set(outcome, history);
  }

  private isInCooldown(outcome: string): boolean {
    const lastExit = this.lastExitTime.get(outcome) ?? 0;
    return Date.now() - lastExit < this.spikeConfig.cooldownMs;
  }

  private detectSpikeDown(outcome: string, price: number): boolean {
    const ema = this.emaPrices.get(outcome) ?? 0;
    const history = this.priceHistory.get(outcome) ?? [];

    if (ema <= 0 || history.length < this.spikeConfig.emaPeriod) {
      return false;
    }

    const deviation = (price - ema) / ema;
    return deviation <= -this.spikeConfig.spikeThreshold;
  }

  private async checkSpikeAndBuy(
    outcome: string,
    price: number,
    tokenId: string,
    orderbook: Orderbook
  ): Promise<void> {
    if (this.isInCooldown(outcome)) {
      return;
    }

    if (!this.detectSpikeDown(outcome, price)) {
      return;
    }

    const ask = OrderbookUtils.bestAsk(orderbook);
    if (ask === null || ask <= 0 || ask > 1.0) {
      return;
    }

    const entryPrice = Math.round(ask * 100) / 100;

    const ema = this.emaPrices.get(outcome) ?? 0;
    this.log(
      `SPIKE DETECTED [${outcome}]: ${price.toFixed(4)} < EMA ${ema.toFixed(4)} -> BUY @ ${entryPrice.toFixed(4)}`
    );

    try {
      const order = await this.placeOrder(
        outcome,
        OrderSide.BUY,
        entryPrice,
        this.spikeConfig.positionSize,
        tokenId
      );

      if (order) {
        this.entries.set(outcome, {
          entryPrice,
          size: this.spikeConfig.positionSize,
          entryTime: Date.now(),
        });
      }
    } catch (error) {
      this.log(`Buy failed for ${outcome}: ${error}`);
    }
  }

  private async managePosition(
    outcome: string,
    price: number,
    exchangePos: number,
    tokenId: string,
    entry: EntryPosition
  ): Promise<void> {
    if (exchangePos < 1) {
      this.entries.delete(outcome);
      return;
    }

    if (entry.entryPrice <= 0) {
      this.entries.delete(outcome);
      return;
    }

    const pnl = (price - entry.entryPrice) / entry.entryPrice;

    let reason: string | null = null;

    if (pnl >= this.spikeConfig.profitTarget) {
      reason = `TP +${(pnl * 100).toFixed(1)}%`;
    } else if (pnl <= -this.spikeConfig.stopLoss) {
      reason = `SL ${(pnl * 100).toFixed(1)}%`;
    }

    if (!reason) {
      return;
    }

    const orderbook = this.orderbookProvider?.getOrderbook();
    if (!orderbook) return;

    const bid = OrderbookUtils.bestBid(orderbook);
    if (bid === null || bid <= 0) {
      return;
    }

    const exitPrice = Math.round(bid * 100) / 100;
    const exitSize = Math.min(exchangePos, entry.size);

    try {
      await this.placeOrder(outcome, OrderSide.SELL, exitPrice, exitSize, tokenId);

      const pnlColor = pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
      this.log(`EXIT [${outcome}] @ ${exitPrice.toFixed(4)} - ${pnlColor}${reason}\x1b[0m`);

      this.entries.delete(outcome);
      this.lastExitTime.set(outcome, Date.now());
    } catch (error) {
      this.log(`Exit failed for ${outcome}: ${error}`);
    }
  }

  private async closeAllPositions(): Promise<void> {
    if (!this.market) return;

    const orderbook = this.orderbookProvider?.getOrderbook();
    if (!orderbook) return;

    const bid = OrderbookUtils.bestBid(orderbook);
    if (bid === null || bid <= 0) return;

    const exitPrice = Math.round(bid * 100) / 100;

    for (const [outcome, entry] of this.entries) {
      const tokenId = this.tokenIds.get(outcome);
      if (!tokenId) continue;

      const position = this.getPosition(outcome);
      const positionSize = position?.size ?? 0;

      if (positionSize < 1) continue;

      try {
        await this.placeOrder(
          outcome,
          OrderSide.SELL,
          exitPrice,
          Math.min(positionSize, entry.size),
          tokenId
        );
        this.log(`Cleanup: sold ${outcome} position`);
      } catch (error) {
        this.log(`Cleanup sell failed for ${outcome}: ${error}`);
      }
    }
  }

  private logStatus(): void {
    if (this.entries.size === 0) return;

    const orderbook = this.orderbookProvider?.getOrderbook();
    if (!orderbook) return;

    const price = this.getMidPrice(orderbook);
    if (price === null) return;

    const parts: string[] = [];

    for (const [outcome, entry] of this.entries) {
      const pnl = (price - entry.entryPrice) / entry.entryPrice;
      const pnlStr = `${(pnl * 100).toFixed(1)}%`;
      const color = pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
      parts.push(`${outcome.slice(0, 8)}: ${color}${pnl >= 0 ? '+' : ''}${pnlStr}\x1b[0m`);
    }

    if (parts.length > 0) {
      this.log(`Positions: ${parts.join(' | ')}`);
    }
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

function parseArgs(): SpikeStrategyConfig & { exchangeId: string; marketId?: string } {
  const args = process.argv.slice(2);
  const config: SpikeStrategyConfig & { exchangeId: string; marketId?: string } = {
    exchangeId: process.env.EXCHANGE ?? 'polymarket',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '-e':
      case '--exchange':
        config.exchangeId = next ?? config.exchangeId;
        i++;
        break;
      case '-m':
      case '--market-id':
        config.marketId = next;
        i++;
        break;
      case '--spike-threshold':
        config.spikeThreshold = Number.parseFloat(next ?? '0.015');
        i++;
        break;
      case '--profit-target':
        config.profitTarget = Number.parseFloat(next ?? '0.03');
        i++;
        break;
      case '--stop-loss':
        config.stopLoss = Number.parseFloat(next ?? '0.02');
        i++;
        break;
      case '--position-size':
        config.positionSize = Number.parseFloat(next ?? '5');
        i++;
        break;
      case '--ema-period':
        config.emaPeriod = Number.parseInt(next ?? '30', 10);
        i++;
        break;
      case '--cooldown':
        config.cooldownMs = Number.parseFloat(next ?? '30') * 1000;
        i++;
        break;
      case '--tick-interval':
        config.tickInterval = Number.parseInt(next ?? '1000', 10);
        i++;
        break;
      case '--no-websocket':
        config.useWebSocket = false;
        break;
      case '-v':
      case '--verbose':
        config.verbose = true;
        break;
      case '-h':
      case '--help':
        console.log(`
Spike Strategy - Mean Reversion for Prediction Markets

Usage:
  EXCHANGE=polymarket PRIVATE_KEY=0x... npx tsx examples/spike-strategy.ts [options]

Options:
  -e, --exchange <name>      Exchange name (default: polymarket)
  -m, --market-id <id>       Market ID (auto-selects if not provided)
  --spike-threshold <n>      Spike detection threshold (default: 0.015 = 1.5%)
  --profit-target <n>        Take profit target (default: 0.03 = 3%)
  --stop-loss <n>            Stop loss limit (default: 0.02 = 2%)
  --position-size <n>        Position size in USD (default: 5)
  --ema-period <n>           EMA period in ticks (default: 30)
  --cooldown <n>             Cooldown after exit in seconds (default: 30)
  --tick-interval <n>        Strategy tick interval in ms (default: 1000)
  --no-websocket             Use REST polling instead of WebSocket
  -v, --verbose              Verbose logging
  -h, --help                 Show this help

Environment Variables:
  EXCHANGE                   Default exchange
  PRIVATE_KEY                Private key for signing
  KALSHI_API_KEY_ID          Kalshi API key ID
  KALSHI_PRIVATE_KEY_PATH    Path to Kalshi private key PEM
  PREDICTFUN_API_KEY         Predict.fun API key
  OPINION_API_KEY            Opinion API key

Examples:
  # Basic run with Polymarket
  EXCHANGE=polymarket PRIVATE_KEY=0x... npx tsx examples/spike-strategy.ts

  # Aggressive settings (lower threshold, faster TP)
  npx tsx examples/spike-strategy.ts --spike-threshold 0.01 --profit-target 0.02

  # Conservative settings
  npx tsx examples/spike-strategy.ts --spike-threshold 0.025 --profit-target 0.05 --ema-period 60
`);
        process.exit(0);
    }
  }

  return config;
}

async function main() {
  const config = parseArgs();

  console.log('='.repeat(60));
  console.log('Spike Strategy - Mean Reversion');
  console.log('='.repeat(60));
  console.log(`Exchange: ${config.exchangeId}`);
  console.log(`Available exchanges: ${listExchanges().join(', ')}`);
  console.log('');

  const { exchange, requiresAuth } = createExchangeWithConfig(config.exchangeId);

  if (!requiresAuth) {
    console.log('Running in SIMULATION mode (no credentials provided)');
    console.log('Orders will NOT be executed.\n');
  } else {
    console.log('Running in LIVE mode (credentials provided)');
    console.log('Orders WILL be executed!\n');
  }

  let market: Market | null = null;

  if (config.marketId) {
    console.log(`Using provided market ID: ${config.marketId}`);
    market = await exchange.fetchMarket(config.marketId);
  } else {
    console.log('Finding a suitable market with liquidity...');
    const liquidityThresholds = [10000, 5000, 1000, 500, 100];

    for (const minLiquidity of liquidityThresholds) {
      try {
        market = await exchange.findTradeableMarket({
          binary: true,
          minLiquidity,
        });
        if (market && market.liquidity > 0) {
          console.log(`Found market with minLiquidity >= $${minLiquidity}`);
          break;
        }
      } catch {}
    }
  }

  if (!market) {
    console.error('No suitable market found with liquidity.');
    console.error('Please specify a market ID with --market-id <id>');
    console.error('You can find active markets at: https://polymarket.com/markets');
    process.exit(1);
  }

  if (market.liquidity === 0) {
    console.warn('\nWARNING: Selected market has $0 liquidity!');
    console.warn('This means no orderbook data will be available.');
    console.warn('Please use --market-id to specify an active market.\n');
    process.exit(1);
  }

  console.log(`\nSelected market: ${market.question}`);
  console.log(`  ID: ${market.id}`);
  console.log(`  Volume: $${market.volume.toLocaleString()}`);
  console.log(`  Liquidity: $${market.liquidity.toLocaleString()}`);
  console.log(`  Outcomes: ${market.outcomes.join(', ')}`);
  console.log('');

  const strategy = new SpikeStrategy(exchange, market.id, {
    spikeThreshold: config.spikeThreshold,
    profitTarget: config.profitTarget,
    stopLoss: config.stopLoss,
    positionSize: config.positionSize,
    emaPeriod: config.emaPeriod,
    cooldownMs: config.cooldownMs,
    tickInterval: config.tickInterval ?? 1000,
    verbose: config.verbose ?? true,
    useWebSocket: config.useWebSocket,
    restPollingInterval: config.restPollingInterval,
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
