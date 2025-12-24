import { OrderbookUtils, PolymarketWebSocket } from '../src/index.js';

const TOKEN_IDS = [
  '21742633143463906290569050155826241533067272736897614950488156847949938836455',
  '48331043336612883890938759509493159234755048973500640148014422747788308965732',
];

async function main() {
  const ws = new PolymarketWebSocket();

  ws.on('open', () => {
    console.log('WebSocket connected');
    ws.subscribeToOrderbook(TOKEN_IDS);
  });

  ws.on('orderbook', (update) => {
    const { tokenId, orderbook } = update;
    const bid = OrderbookUtils.bestBid(orderbook);
    const ask = OrderbookUtils.bestAsk(orderbook);
    const spread = OrderbookUtils.spread(orderbook);
    const mid = OrderbookUtils.midPrice(orderbook);

    console.log(
      `[${tokenId.slice(0, 8)}...] Bid: ${bid?.toFixed(3) ?? 'N/A'} | Ask: ${ask?.toFixed(3) ?? 'N/A'} | Spread: ${spread?.toFixed(4) ?? 'N/A'} | Mid: ${mid?.toFixed(3) ?? 'N/A'}`
    );
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  ws.on('close', () => {
    console.log('WebSocket closed');
  });

  await ws.connect();

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await ws.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
