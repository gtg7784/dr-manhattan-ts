import { createExchange, listExchanges, MarketUtils } from '../src/index.js';

async function main() {
  console.log('Available exchanges:', listExchanges().join(', '));

  const polymarket = createExchange('polymarket');
  console.log(`\nExchange: ${polymarket.name}`);
  console.log('Capabilities:', polymarket.describe().has);

  console.log('\nFetching markets...');
  const polymarketMarkets = await polymarket.fetchMarkets({ limit: 5 });

  for (const market of polymarketMarkets) {
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

  const predictfunApiKey = process.env.PREDICTFUN_API_KEY;
  const predictfunPrivateKey = process.env.PREDICTFUN_PRIVATE_KEY ?? process.env.PRIVATE_KEY;

  if (predictfunApiKey) {
    const predictfun = createExchange('predictfun', {
      apiKey: predictfunApiKey,
      privateKey: predictfunPrivateKey,
    });
    console.log(`\nExchange: ${predictfun.name}`);
    console.log('Capabilities:', predictfun.describe().has);

    console.log('\nFetching markets...');
    const predictfunMarkets = await predictfun.fetchMarkets({ limit: 5 });
    for (const market of predictfunMarkets) {
      console.log('\n---');
      console.log(`ID: ${market.id}`);
      console.log(`Question: ${market.question}`);
      console.log(`Outcomes: ${market.outcomes.join(' vs ')}`);
      console.log(`Volume: $${market.volume.toLocaleString()}`);
      console.log(`Is Binary: ${MarketUtils.isBinary(market)}`);
      console.log(`Is Open: ${MarketUtils.isOpen(market)}`);
    }
  } else {
    console.log('\n[Predict.fun] Skipped - PREDICTFUN_API_KEY required');
  }

  const kalshi = createExchange('kalshi');
  console.log(`\nExchange: ${kalshi.name}`);
  console.log('Capabilities:', kalshi.describe().has);

  console.log('\nFetching markets...');
  const kalshiMarkets = await kalshi.fetchMarkets({ limit: 5 });
  for (const market of kalshiMarkets) {
    console.log('\n---');
    console.log(`ID: ${market.id}`);
    console.log(`Question: ${market.question}`);
    console.log(`Outcomes: ${market.outcomes.join(' vs ')}`);
    console.log(`Volume: $${market.volume.toLocaleString()}`);
    console.log(`Is Binary: ${MarketUtils.isBinary(market)}`);
    console.log(`Is Open: ${MarketUtils.isOpen(market)}`);
  }

  const limitless = createExchange('limitless');
  console.log(`\nExchange: ${limitless.name}`);
  console.log('Capabilities:', limitless.describe().has);

  console.log('\nFetching markets...');
  const limitlessMarkets = await limitless.fetchMarkets({ limit: 5 });
  for (const market of limitlessMarkets) {
    console.log('\n---');
    console.log(`ID: ${market.id}`);
    console.log(`Question: ${market.question}`);
    console.log(`Outcomes: ${market.outcomes.join(' vs ')}`);
    console.log(`Volume: $${market.volume.toLocaleString()}`);
    console.log(`Is Binary: ${MarketUtils.isBinary(market)}`);
    console.log(`Is Open: ${MarketUtils.isOpen(market)}`);
    console.log(`Close Time: ${market.closeTime?.toISOString()}`);
    console.log(`Description: ${market.description}`);
    console.log(`Tick Size: ${market.tickSize}`);
    console.log(`Liquidity: $${market.liquidity.toLocaleString()}`);
    console.log(
      `Prices: ${Object.entries(market.prices)
        .map(([outcome, price]) => `${outcome}: ${(price * 100).toFixed(1)}%`)
        .join(', ')}`
    );
  }

  const opinionApiKey = process.env.OPINION_API_KEY;

  if (opinionApiKey) {
    const opinion = createExchange('opinion', { apiKey: opinionApiKey });
    console.log(`\nExchange: ${opinion.name}`);
    console.log('Capabilities:', opinion.describe().has);

    console.log('\nFetching markets...');
    const opinionMarkets = await opinion.fetchMarkets({ limit: 5 });
    for (const market of opinionMarkets) {
      console.log('\n---');
      console.log(`ID: ${market.id}`);
      console.log(`Question: ${market.question}`);
      console.log(`Outcomes: ${market.outcomes.join(' vs ')}`);
      console.log(`Volume: $${market.volume.toLocaleString()}`);
      console.log(`Is Binary: ${MarketUtils.isBinary(market)}`);
      console.log(`Is Open: ${MarketUtils.isOpen(market)}`);
    }
  } else {
    console.log('\n[Opinion] Skipped - OPINION_API_KEY required');
  }
}

main().catch(console.error);
