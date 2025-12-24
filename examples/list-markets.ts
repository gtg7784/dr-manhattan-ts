import { MarketUtils, createExchange, listExchanges } from '../src/index.js';

async function main() {
  console.log('Available exchanges:', listExchanges().join(', '));

  const polymarket = createExchange('polymarket');
  console.log(`\nExchange: ${polymarket.name}`);
  console.log('Capabilities:', polymarket.describe().has);

  console.log('\nFetching markets...');
  const markets = await polymarket.fetchMarkets({ limit: 5 });

  for (const market of markets) {
    console.log('\n---');
    console.log(`ID: ${market.id}`);
    console.log(`Question: ${market.question}`);
    console.log(`Outcomes: ${market.outcomes.join(' vs ')}`);
    console.log(`Volume: $${market.volume.toLocaleString()}`);
    console.log(`Is Binary: ${MarketUtils.isBinary(market)}`);
    console.log(`Is Open: ${MarketUtils.isOpen(market)}`);

    const prices = Object.entries(market.prices);
    for (const [outcome, price] of prices) {
      console.log(`  ${outcome}: ${(price * 100).toFixed(1)}%`);
    }
  }
}

main().catch(console.error);
