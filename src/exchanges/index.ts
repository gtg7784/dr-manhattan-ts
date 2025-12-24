import type { Exchange, ExchangeConfig } from '../core/exchange.js';
import { Limitless } from './limitless/index.js';
import { Opinion } from './opinion/index.js';
import { Polymarket } from './polymarket/index.js';

export { Polymarket, PolymarketWebSocket } from './polymarket/index.js';
export { Opinion } from './opinion/index.js';
export { Limitless } from './limitless/index.js';

type ExchangeClass = new (config?: ExchangeConfig) => Exchange;

const exchanges: Record<string, ExchangeClass> = {
  polymarket: Polymarket,
  opinion: Opinion,
  limitless: Limitless,
};

export function listExchanges(): string[] {
  return Object.keys(exchanges);
}

export function createExchange(exchangeId: string, config?: ExchangeConfig): Exchange {
  const ExchangeClass = exchanges[exchangeId.toLowerCase()];
  if (!ExchangeClass) {
    throw new Error(`Exchange '${exchangeId}' not found. Available: ${listExchanges().join(', ')}`);
  }
  return new ExchangeClass(config);
}
