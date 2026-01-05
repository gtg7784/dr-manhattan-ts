/**
 * Weather Bot Strategy - London Temperature Range Markets
 *
 * Based on the Polymarket bot that turned $204 into $24,000 with 1,300+ trades and 73% win rate.
 *
 * Usage:
 *   npx tsx examples/weather-bot-strategy.ts --dry-run
 *   PRIVATE_KEY=0x... npx tsx examples/weather-bot-strategy.ts
 */

import { type Market, MarketUtils, OrderSide, Polymarket } from '../src/index.js';

interface WeatherBotConfig {
  /** Minimum price to buy buckets (default: 0.15) */
  targetPriceMin: number;
  /** Maximum price to buy buckets (default: 0.35) */
  targetPriceMax: number;
  /** Max number of temperature markets to trade per day (default: 5) */
  maxMarketsPerDay: number;
  /** Maximum position size per market (default: 50) */
  maxPositionPerMarket: number;
  /** Default order size (default: 10) */
  orderSize: number;
  /** Seconds between strategy ticks (default: 30) */
  checkInterval: number;
  /** Dry run mode - analyze without placing orders (default: false) */
  dryRun: boolean;
  /** Verbose logging (default: true) */
  verbose: boolean;
}

interface BucketOpportunity {
  market: Market;
  outcome: string;
  price: number;
  valueScore: number;
  tokenId: string;
}

const Colors = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

class WeatherBotStrategy {
  private exchange: Polymarket;
  private config: WeatherBotConfig;
  private isRunning = false;
  private marketPositions: Map<string, Map<string, number>> = new Map();
  private marketsTraded: Set<string> = new Set();

  // Pattern: "Will the highest temperature in London be 0°C on January 5?"
  // Also matches: "-2°C or below", "4°C or higher"
  private temperaturePattern = /temperature.*London.*(-?\d+)°[CF]/i;
  private temperaturePatternAlt = /London.*temperature.*(-?\d+)°[CF]/i;

  constructor(exchange: Polymarket, config: Partial<WeatherBotConfig> = {}) {
    this.exchange = exchange;
    this.config = {
      targetPriceMin: config.targetPriceMin ?? 0.15,
      targetPriceMax: config.targetPriceMax ?? 0.35,
      maxMarketsPerDay: config.maxMarketsPerDay ?? 5,
      maxPositionPerMarket: config.maxPositionPerMarket ?? 50,
      orderSize: config.orderSize ?? 10,
      checkInterval: config.checkInterval ?? 30,
      dryRun: config.dryRun ?? false,
      verbose: config.verbose ?? true,
    };
  }

  private log(message: string): void {
    if (this.config.verbose) {
      const timestamp = new Date().toISOString().slice(11, 19);
      console.log(`[${Colors.dim(timestamp)}] ${message}`);
    }
  }

  async findLondonTemperatureMarkets(): Promise<Market[]> {
    this.log('Searching for London temperature markets...');

    const temperatureMarkets: Market[] = [];

    try {
      const londonMarkets = await this.exchange.searchMarkets({
        query: 'London',
        limit: 200,
        closed: false,
      });

      const tempMarkets = await this.exchange.searchMarkets({
        query: 'temperature',
        limit: 200,
        closed: false,
      });

      const allMarkets = new Map<string, Market>();
      for (const market of [...londonMarkets, ...tempMarkets]) {
        allMarkets.set(market.id, market);
      }

      for (const market of allMarkets.values()) {
        if (this.isTemperatureMarket(market)) {
          temperatureMarkets.push(market);
          this.log(`  Found: ${Colors.cyan(market.question.slice(0, 70))}...`);
        }
      }
    } catch (error) {
      this.log(`${Colors.red('Search failed:')} ${error}`);
    }

    this.log(
      `Found ${Colors.yellow(String(temperatureMarkets.length))} London temperature markets`
    );
    return temperatureMarkets;
  }

  private isTemperatureMarket(market: Market): boolean {
    const question = market.question.toLowerCase();

    if (!question.includes('london')) return false;
    if (!question.includes('temperature')) return false;

    return (
      this.temperaturePattern.test(market.question) ||
      this.temperaturePatternAlt.test(market.question)
    );
  }

  async analyzeBucketPricing(markets: Market[]): Promise<BucketOpportunity[]> {
    const opportunities: BucketOpportunity[] = [];

    for (const market of markets) {
      if (!MarketUtils.isOpen(market)) continue;

      const tokenIds = MarketUtils.getTokenIds(market);

      if (MarketUtils.isBinary(market)) {
        const yesPrice = market.prices.Yes ?? market.prices.yes ?? 0;
        const tokenId = tokenIds[0];

        if (tokenId && this.isInTargetRange(yesPrice)) {
          const valueScore = this.calculateValueScore(yesPrice);
          opportunities.push({
            market,
            outcome: 'Yes',
            price: yesPrice,
            valueScore,
            tokenId,
          });

          this.log(
            `  Opportunity: ${market.question.slice(0, 50)}... | ` +
              `Yes: ${Colors.yellow(yesPrice.toFixed(2))} | ` +
              `Value: ${Colors.cyan(valueScore.toFixed(2))}`
          );
        }
      } else {
        for (let i = 0; i < market.outcomes.length; i++) {
          const outcome = market.outcomes[i];
          if (!outcome) continue;

          const price = market.prices[outcome] ?? 0;
          const tokenId = tokenIds[i];

          if (tokenId && this.isInTargetRange(price)) {
            const valueScore = this.calculateValueScore(price);
            opportunities.push({
              market,
              outcome,
              price,
              valueScore,
              tokenId,
            });

            this.log(
              `  Opportunity: ${market.question.slice(0, 50)}... | ` +
                `${Colors.magenta(outcome)}: ${Colors.yellow(price.toFixed(2))} | ` +
                `Value: ${Colors.cyan(valueScore.toFixed(2))}`
            );
          }
        }
      }
    }

    opportunities.sort((a, b) => b.valueScore - a.valueScore);

    this.log(`Found ${Colors.yellow(String(opportunities.length))} pricing opportunities`);
    return opportunities;
  }

  private isInTargetRange(price: number): boolean {
    return price >= this.config.targetPriceMin && price <= this.config.targetPriceMax;
  }

  private calculateValueScore(price: number): number {
    const range = this.config.targetPriceMax - this.config.targetPriceMin;
    if (range <= 0) return 0;
    return 1.0 - (price - this.config.targetPriceMin) / range;
  }

  async placeBucketOrders(opportunities: BucketOpportunity[]): Promise<void> {
    let ordersPlaced = 0;

    for (const opp of opportunities) {
      if (this.marketsTraded.size >= this.config.maxMarketsPerDay) {
        this.log(`Reached max markets per day (${this.config.maxMarketsPerDay})`);
        break;
      }

      const marketId = opp.market.id;

      const marketPositions = this.marketPositions.get(marketId) ?? new Map<string, number>();
      const currentPosition = marketPositions.get(opp.outcome) ?? 0;

      if (currentPosition >= this.config.maxPositionPerMarket) {
        this.log(`  Skipping ${opp.outcome} - max position reached`);
        continue;
      }

      const remaining = this.config.maxPositionPerMarket - currentPosition;
      const size = Math.min(this.config.orderSize, remaining);

      if (size < 1) continue;

      const tickSize = opp.market.tickSize ?? 0.01;
      const entryPrice = Math.round(opp.price / tickSize) * tickSize;

      this.log(
        `  -> BUY ${Colors.cyan(String(size))} ${Colors.magenta(opp.outcome.slice(0, 20))} ` +
          `@ ${Colors.yellow(entryPrice.toFixed(4))}`
      );

      if (this.config.dryRun) {
        this.log(`     ${Colors.dim('[DRY RUN - Order not placed]')}`);
        ordersPlaced++;
        this.marketsTraded.add(marketId);
        continue;
      }

      try {
        const conditionId = (opp.market.metadata.conditionId as string) ?? opp.market.id;

        await this.exchange.createOrder({
          marketId: conditionId,
          outcome: opp.outcome,
          side: OrderSide.BUY,
          price: entryPrice,
          size,
          tokenId: opp.tokenId,
        });

        marketPositions.set(opp.outcome, currentPosition + size);
        this.marketPositions.set(marketId, marketPositions);
        this.marketsTraded.add(marketId);
        ordersPlaced++;

        this.log(`     ${Colors.green('Order placed successfully')}`);
      } catch (error) {
        this.log(`     ${Colors.red('Failed to place order:')} ${error}`);
      }
    }

    this.log(
      `Placed ${Colors.yellow(String(ordersPlaced))} orders across ${Colors.cyan(String(this.marketsTraded.size))} markets`
    );
  }

  async onTick(): Promise<void> {
    console.log(`\n${Colors.bold('='.repeat(60))}`);
    console.log(Colors.bold('Weather Bot Tick'));
    console.log(Colors.bold('='.repeat(60)));

    const markets = await this.findLondonTemperatureMarkets();

    if (markets.length === 0) {
      this.log('No temperature markets found');
      return;
    }

    const opportunities = await this.analyzeBucketPricing(markets);

    if (opportunities.length === 0) {
      this.log('No opportunities found');
      return;
    }

    await this.placeBucketOrders(opportunities);
  }

  async run(durationMinutes?: number): Promise<void> {
    this.printConfig();

    this.isRunning = true;
    const startTime = Date.now();
    const endTime = durationMinutes ? startTime + durationMinutes * 60 * 1000 : null;

    try {
      while (this.isRunning) {
        if (endTime && Date.now() >= endTime) {
          this.log('Duration limit reached');
          break;
        }

        await this.onTick();
        await this.sleep(this.config.checkInterval * 1000);
      }
    } catch (error) {
      if ((error as Error).message?.includes('SIGINT')) {
        this.log('Interrupted');
      } else {
        throw error;
      }
    } finally {
      this.isRunning = false;
      this.log('Weather bot stopped');
    }
  }

  stop(): void {
    this.isRunning = false;
  }

  private printConfig(): void {
    console.log(`\n${Colors.bold('='.repeat(60))}`);
    console.log(Colors.bold('Weather Bot Strategy'));
    console.log('='.repeat(60));
    console.log(
      `  Target Price Range: ${Colors.yellow(this.config.targetPriceMin.toFixed(2))} - ${Colors.yellow(this.config.targetPriceMax.toFixed(2))}`
    );
    console.log(`  Max Markets/Day: ${Colors.cyan(String(this.config.maxMarketsPerDay))}`);
    console.log(`  Max Position/Market: ${Colors.cyan(String(this.config.maxPositionPerMarket))}`);
    console.log(`  Order Size: ${Colors.cyan(String(this.config.orderSize))}`);
    console.log(`  Check Interval: ${Colors.cyan(String(this.config.checkInterval))}s`);

    if (this.config.dryRun) {
      console.log(`  Mode: ${Colors.magenta('DRY RUN (Analysis Only)')}`);
    } else {
      console.log(`  Mode: ${Colors.green('LIVE TRADING')}`);
    }
    console.log(`${'='.repeat(60)}\n`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function parseArgs(): Partial<WeatherBotConfig> & { duration?: number } {
  const args = process.argv.slice(2);
  const config: Partial<WeatherBotConfig> & { duration?: number } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--target-price-min':
        config.targetPriceMin = Number.parseFloat(next ?? '0.15');
        i++;
        break;
      case '--target-price-max':
        config.targetPriceMax = Number.parseFloat(next ?? '0.35');
        i++;
        break;
      case '--max-markets':
        config.maxMarketsPerDay = Number.parseInt(next ?? '5', 10);
        i++;
        break;
      case '--max-position':
        config.maxPositionPerMarket = Number.parseFloat(next ?? '50');
        i++;
        break;
      case '--order-size':
        config.orderSize = Number.parseFloat(next ?? '10');
        i++;
        break;
      case '--interval':
        config.checkInterval = Number.parseFloat(next ?? '30');
        i++;
        break;
      case '--duration':
        config.duration = Number.parseInt(next ?? '0', 10) || undefined;
        i++;
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '-v':
      case '--verbose':
        config.verbose = true;
        break;
      case '-q':
      case '--quiet':
        config.verbose = false;
        break;
      case '-h':
      case '--help':
        console.log(`
Weather Bot Strategy - London Temperature Range Markets

Identifies mispriced temperature bucket markets and spreads exposure
across multiple adjacent ranges to exploit probability mispricing.

Usage:
  npx tsx examples/weather-bot-strategy.ts [options]

Options:
  --target-price-min <n>   Minimum price to buy buckets (default: 0.15)
  --target-price-max <n>   Maximum price to buy buckets (default: 0.35)
  --max-markets <n>        Maximum markets to trade per day (default: 5)
  --max-position <n>       Maximum position per market (default: 50)
  --order-size <n>         Order size (default: 10)
  --interval <n>           Check interval in seconds (default: 30)
  --duration <n>           Run duration in minutes (default: unlimited)
  --dry-run                Dry run mode - analyze without placing orders
  -v, --verbose            Verbose logging (default)
  -q, --quiet              Quiet mode
  -h, --help               Show this help

Environment Variables:
  PRIVATE_KEY              Your Polymarket private key (required for trading)
  POLYMARKET_FUNDER        Funder address (optional)

Examples:
  npx tsx examples/weather-bot-strategy.ts --dry-run
  PRIVATE_KEY=0x... npx tsx examples/weather-bot-strategy.ts --order-size 5
  npx tsx examples/weather-bot-strategy.ts --target-price-min 0.20 --target-price-max 0.30
`);
        process.exit(0);
    }
  }

  return config;
}

async function main(): Promise<number> {
  const config = parseArgs();

  console.log(Colors.bold('\nWeather Bot Strategy'));
  console.log('='.repeat(60));

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey && !config.dryRun) {
    console.log(Colors.yellow('WARNING: PRIVATE_KEY not set. Running in DRY RUN mode.'));
    config.dryRun = true;
  }

  const exchange = new Polymarket({
    privateKey,
    funder: process.env.POLYMARKET_FUNDER,
    verbose: false,
  });

  console.log(`Exchange: ${Colors.cyan('POLYMARKET')}`);

  if (!config.dryRun && privateKey) {
    console.log(`Wallet: ${Colors.cyan(exchange.walletAddress ?? 'unknown')}`);
  }

  const strategy = new WeatherBotStrategy(exchange, config);

  const shutdown = () => {
    console.log('\nShutting down...');
    strategy.stop();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await strategy.run(config.duration);
  } catch (error) {
    console.error(Colors.red('Fatal error:'), error);
    return 1;
  }

  return 0;
}

main().then((code) => process.exit(code));
