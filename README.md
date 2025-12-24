# dr-manhattan

CCXT-style unified API for prediction markets in TypeScript.

> TypeScript port of [guzus/dr-manhattan](https://github.com/guzus/dr-manhattan) (Python)

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## Supported Exchanges

| Exchange | REST | WebSocket | Chain |
|----------|------|-----------|-------|
| [Polymarket](https://polymarket.com) | ✅ | ✅ | Polygon |
| [Limitless](https://limitless.exchange) | ✅ | ✅ | Base |
| [Opinion](https://opinion.trade) | ✅ | ❌ | BNB |

## Installation

```bash
npm install dr-manhattan
# or
pnpm add dr-manhattan
# or
yarn add dr-manhattan
```

## Quick Start

```typescript
import { createExchange, listExchanges, MarketUtils } from 'dr-manhattan';

// List available exchanges
console.log(listExchanges()); // ['polymarket', 'limitless', 'opinion']

// Create exchange instance (no auth required for public data)
const polymarket = createExchange('polymarket');

// Fetch markets
const markets = await polymarket.fetchMarkets({ limit: 10 });

for (const market of markets) {
  console.log(`${market.question}`);
  console.log(`  Volume: $${market.volume.toLocaleString()}`);
  console.log(`  Binary: ${MarketUtils.isBinary(market)}`);
  console.log(`  Spread: ${MarketUtils.spread(market)?.toFixed(4)}`);
}
```

## Authentication

### Polymarket

```typescript
import { Polymarket } from 'dr-manhattan';

const polymarket = new Polymarket({
  privateKey: process.env.PRIVATE_KEY,
  funder: process.env.FUNDER_ADDRESS, // optional
  chainId: 137, // Polygon (default)
});

// Create order
const order = await polymarket.createOrder({
  marketId: 'market-condition-id',
  outcome: 'Yes',
  side: OrderSide.BUY,
  price: 0.65,
  size: 100,
  tokenId: 'outcome-token-id',
});

// Fetch balance
const balance = await polymarket.fetchBalance();
console.log(`USDC: ${balance.USDC}`);
```

### Limitless

```typescript
import { Limitless } from 'dr-manhattan';

const limitless = new Limitless({
  privateKey: process.env.PRIVATE_KEY,
});

// Authentication happens automatically via EIP-191/EIP-712 signing
const positions = await limitless.fetchPositions();
```

### Opinion

```typescript
import { Opinion } from 'dr-manhattan';

const opinion = new Opinion({
  apiKey: process.env.OPINION_API_KEY,
  privateKey: process.env.PRIVATE_KEY,
  multiSigAddr: process.env.MULTI_SIG_ADDR,
});
```

## API Reference

### Exchange Methods

All exchanges implement these core methods:

```typescript
interface Exchange {
  // Market data
  fetchMarkets(params?: FetchMarketsParams): Promise<Market[]>;
  fetchMarket(marketId: string): Promise<Market>;

  // Orders (requires auth)
  createOrder(params: CreateOrderParams): Promise<Order>;
  cancelOrder(orderId: string, marketId?: string): Promise<Order>;
  fetchOrder(orderId: string, marketId?: string): Promise<Order>;
  fetchOpenOrders(marketId?: string): Promise<Order[]>;

  // Account (requires auth)
  fetchPositions(marketId?: string): Promise<Position[]>;
  fetchBalance(): Promise<Record<string, number>>;

  // Utilities
  describe(): { id: string; name: string; has: ExchangeCapabilities };
  findTradeableMarket(options?: { binary?: boolean; minLiquidity?: number }): Promise<Market | null>;
  calculateSpread(market: Market): number | null;
}
```

### Polymarket-specific Methods

```typescript
// Search markets by keyword
const markets = await polymarket.searchMarkets('bitcoin');

// Fetch by slug
const market = await polymarket.fetchMarketsBySlug('bitcoin-100k');

// Get orderbook
const orderbook = await polymarket.getOrderbook(tokenId);

// Fetch price history
const history = await polymarket.fetchPriceHistory(tokenId, '1d');

// Fetch public trades
const trades = await polymarket.fetchPublicTrades(tokenId, { limit: 50 });

// Find crypto hourly markets
const hourlyMarket = await polymarket.findCryptoHourlyMarket('BTC', 'higher');
```

### WebSocket Streaming

#### Polymarket WebSocket

```typescript
import { PolymarketWebSocket, OrderbookUtils } from 'dr-manhattan';

const ws = new PolymarketWebSocket();

ws.on('open', () => {
  ws.subscribeToOrderbook([tokenId1, tokenId2]);
});

ws.on('orderbook', ({ tokenId, orderbook }) => {
  const bid = OrderbookUtils.bestBid(orderbook);
  const ask = OrderbookUtils.bestAsk(orderbook);
  console.log(`[${tokenId}] Bid: ${bid} | Ask: ${ask}`);
});

ws.on('error', (err) => console.error(err));
ws.on('close', () => console.log('Disconnected'));

await ws.connect();

// Cleanup
await ws.disconnect();
```

#### Limitless WebSocket

```typescript
import { Limitless } from 'dr-manhattan';
import { LimitlessWebSocket } from 'dr-manhattan/exchanges/limitless';

const ws = new LimitlessWebSocket();

ws.on('orderbook', ({ marketAddress, orderbook }) => {
  console.log(`[${marketAddress}] Updated`);
});

ws.on('price', ({ marketAddress, prices }) => {
  console.log(`Prices:`, prices);
});

await ws.connect();
ws.subscribeToMarket(marketAddress);
```

## Utilities

### Market Utilities

```typescript
import { MarketUtils } from 'dr-manhattan';

MarketUtils.isBinary(market);      // Has exactly 2 outcomes
MarketUtils.isOpen(market);        // Not closed, not resolved
MarketUtils.spread(market);        // Price spread between outcomes
MarketUtils.getTokenIds(market);   // Extract token IDs
```

### Orderbook Utilities

```typescript
import { OrderbookUtils } from 'dr-manhattan';

OrderbookUtils.bestBid(orderbook);     // Highest bid price
OrderbookUtils.bestAsk(orderbook);     // Lowest ask price
OrderbookUtils.spread(orderbook);      // Ask - Bid
OrderbookUtils.midPrice(orderbook);    // (Bid + Ask) / 2
OrderbookUtils.totalVolume(orderbook, 'bids'); // Sum of bid sizes
```

### Position Utilities

```typescript
import { PositionUtils, calculateDelta } from 'dr-manhattan';

PositionUtils.totalValue(positions);
PositionUtils.totalPnl(positions);
PositionUtils.filterByMarket(positions, marketId);

// Calculate position delta
const delta = calculateDelta(positions, market);
// { yes: 100, no: -50, net: 50 }
```

### Price Utilities

```typescript
import { roundToTickSize, clampPrice, formatPrice, formatUsd } from 'dr-manhattan';

roundToTickSize(0.6543, 0.01);  // 0.65
clampPrice(1.5);                 // 1.0
formatPrice(0.6543);             // "0.654"
formatUsd(1234567);              // "$1,234,567"
```

## Error Handling

```typescript
import {
  DrManhattanError,
  ExchangeError,
  NetworkError,
  RateLimitError,
  AuthenticationError,
  InsufficientFunds,
  InvalidOrder,
  MarketNotFound,
} from 'dr-manhattan';

try {
  await exchange.createOrder(params);
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log(`Rate limited, retry after ${error.retryAfter}ms`);
  } else if (error instanceof InsufficientFunds) {
    console.log('Not enough balance');
  } else if (error instanceof InvalidOrder) {
    console.log('Invalid order parameters');
  }
}
```

## Types

```typescript
import type {
  Market,
  OutcomeToken,
  Order,
  CreateOrderParams,
  Position,
  DeltaInfo,
  Orderbook,
  PriceLevel,
  FetchMarketsParams,
  ExchangeConfig,
  ExchangeCapabilities,
} from 'dr-manhattan';

import { OrderSide, OrderStatus } from 'dr-manhattan';
```

## Adding New Exchanges

```typescript
import { Exchange, type ExchangeConfig } from 'dr-manhattan';

class NewExchange extends Exchange {
  readonly id = 'newexchange';
  readonly name = 'New Exchange';

  async fetchMarkets(params?: FetchMarketsParams): Promise<Market[]> {
    // Implement API call
  }

  async fetchMarket(marketId: string): Promise<Market> {
    // Implement
  }

  // ... implement other abstract methods
}
```

## Configuration Options

```typescript
interface ExchangeConfig {
  // Authentication
  apiKey?: string;
  apiSecret?: string;
  privateKey?: string;
  funder?: string;

  // Request settings
  timeout?: number;      // Request timeout in ms (default: 30000)
  rateLimit?: number;    // Max requests per second (default: 10)
  maxRetries?: number;   // Retry count for failed requests (default: 3)
  retryDelay?: number;   // Initial retry delay in ms (default: 1000)
  retryBackoff?: number; // Backoff multiplier (default: 2)

  // Debug
  verbose?: boolean;     // Log debug info (default: false)
}
```

## Examples

See the [examples/](examples/) directory:

- **list-markets.ts** - Fetch and display markets
- **websocket-orderbook.ts** - Real-time orderbook streaming
- **spread-strategy.ts** - Market making strategy with inventory management

```bash
# Run examples
npx tsx examples/list-markets.ts
npx tsx examples/websocket-orderbook.ts
npx tsx examples/spread-strategy.ts  # Requires PRIVATE_KEY env var for real trades
```

## Requirements

- Node.js >= 20.0.0
- TypeScript >= 5.0 (for development)

## License

MIT
