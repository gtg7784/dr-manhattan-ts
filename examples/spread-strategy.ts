import {
  type Market,
  MarketUtils,
  OrderSide,
  type Orderbook,
  OrderbookUtils,
  Polymarket,
  PolymarketWebSocket,
  Strategy,
  type StrategyConfig,
} from '../src/index.js';

interface SpreadStrategyConfig extends StrategyConfig {
  targetSpreadBps?: number;
  orderSizeUsd?: number;
  maxInventory?: number;
  skewFactor?: number;
}

class SpreadStrategy extends Strategy {
  private ws: PolymarketWebSocket | null = null;
  private orderbook: Orderbook | null = null;
  private tokenId: string | null = null;
  private spreadConfig: SpreadStrategyConfig;

  constructor(exchange: Polymarket, marketId: string, config: SpreadStrategyConfig = {}) {
    super(exchange, marketId, config);
    this.spreadConfig = {
      targetSpreadBps: 200,
      orderSizeUsd: 10,
      maxInventory: 100,
      skewFactor: 0.1,
      tickInterval: 5000,
      verbose: true,
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

    if (this.tokenId) {
      await this.setupWebSocket();
    }

    await super.start();
    this.log(`Started spread strategy on ${this.market.question}`);
  }

  async stop(): Promise<void> {
    await super.stop();
    if (this.ws) {
      await this.ws.disconnect();
      this.ws = null;
    }
    this.log('Stopped spread strategy');
  }

  private async setupWebSocket(): Promise<void> {
    this.ws = new PolymarketWebSocket();

    this.ws.on('orderbook', ({ tokenId, orderbook }) => {
      if (tokenId === this.tokenId) {
        this.orderbook = orderbook;
      }
    });

    this.ws.on('error', (err) => {
      this.log(`WebSocket error: ${err.message}`);
    });

    await this.ws.connect();

    if (this.tokenId) {
      this.ws.subscribeToOrderbook([this.tokenId]);
    }
  }

  async onTick(): Promise<void> {
    if (!this.market || !this.orderbook) {
      this.log('Waiting for orderbook data...');
      return;
    }

    const bestBid = OrderbookUtils.bestBid(this.orderbook);
    const bestAsk = OrderbookUtils.bestAsk(this.orderbook);
    const mid = OrderbookUtils.midPrice(this.orderbook);
    const spread = OrderbookUtils.spread(this.orderbook);

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

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.log('Running in simulation mode (no PRIVATE_KEY set)');
    console.log('Set PRIVATE_KEY env var to execute real trades\n');
  }

  const polymarket = new Polymarket({
    privateKey,
    verbose: true,
  });

  console.log('Finding a suitable market...');
  const market = await polymarket.findTradeableMarket({
    binary: true,
    minLiquidity: 10000,
  });

  if (!market) {
    console.error('No suitable market found');
    process.exit(1);
  }

  console.log(`\nSelected market: ${market.question}`);
  console.log(`  ID: ${market.id}`);
  console.log(`  Volume: $${market.volume.toLocaleString()}`);
  console.log(`  Liquidity: $${market.liquidity.toLocaleString()}`);

  const strategy = new SpreadStrategy(polymarket, market.id, {
    targetSpreadBps: 200,
    orderSizeUsd: 10,
    maxInventory: 100,
    tickInterval: 5000,
    verbose: true,
  });

  strategy.on('order', (order) => {
    console.log(`Order placed: ${order.side} ${order.size} @ ${order.price}`);
  });

  strategy.on('error', (error) => {
    console.error('Strategy error:', error);
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await strategy.stop();
    process.exit(0);
  });

  await strategy.start();
}

main().catch(console.error);
