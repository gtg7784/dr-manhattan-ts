import { beforeEach, describe, expect, it } from 'vitest';
import { type Orderbook, OrderbookManager, OrderbookUtils } from '../src/index.js';

describe('OrderbookUtils', () => {
  describe('bestBid', () => {
    it('should return highest bid price', () => {
      // #given
      const orderbook: Orderbook = {
        bids: [
          [0.5, 200],
          [0.45, 100],
          [0.4, 150],
        ],
        asks: [],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      };

      // #when
      const result = OrderbookUtils.bestBid(orderbook);

      // #then
      expect(result).toBe(0.5);
    });

    it('should return null for empty bids', () => {
      // #given
      const orderbook: Orderbook = {
        bids: [],
        asks: [],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      };

      // #when
      const result = OrderbookUtils.bestBid(orderbook);

      // #then
      expect(result).toBeNull();
    });
  });

  describe('bestAsk', () => {
    it('should return lowest ask price', () => {
      // #given
      const orderbook: Orderbook = {
        bids: [],
        asks: [
          [0.52, 200],
          [0.55, 100],
          [0.6, 150],
        ],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      };

      // #when
      const result = OrderbookUtils.bestAsk(orderbook);

      // #then
      expect(result).toBe(0.52);
    });
  });

  describe('spread', () => {
    it('should calculate spread correctly', () => {
      // #given
      const orderbook: Orderbook = {
        bids: [[0.48, 100]],
        asks: [[0.52, 100]],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      };

      // #when
      const result = OrderbookUtils.spread(orderbook);

      // #then
      expect(result).toBeCloseTo(0.04, 5);
    });

    it('should return null when no bids', () => {
      // #given
      const orderbook: Orderbook = {
        bids: [],
        asks: [[0.52, 100]],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      };

      // #when
      const result = OrderbookUtils.spread(orderbook);

      // #then
      expect(result).toBeNull();
    });
  });

  describe('midPrice', () => {
    it('should calculate mid price correctly', () => {
      // #given
      const orderbook: Orderbook = {
        bids: [[0.48, 100]],
        asks: [[0.52, 100]],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      };

      // #when
      const result = OrderbookUtils.midPrice(orderbook);

      // #then
      expect(result).toBe(0.5);
    });
  });

  describe('fromRestResponse', () => {
    it('should convert REST API response to orderbook', () => {
      // #given
      const data = {
        bids: [
          { price: '0.50', size: '100' },
          { price: '0.48', size: '200' },
        ],
        asks: [
          { price: '0.55', size: '150' },
          { price: '0.52', size: '250' },
        ],
      };

      // #when
      const result = OrderbookUtils.fromRestResponse(data, 'token123');

      // #then
      expect(result.assetId).toBe('token123');
      expect(result.bids[0]).toEqual([0.5, 100]);
      expect(result.asks[0]).toEqual([0.52, 250]);
    });
  });
});

describe('OrderbookManager', () => {
  let manager: OrderbookManager;

  beforeEach(() => {
    manager = new OrderbookManager();
  });

  describe('update and get', () => {
    it('should store and retrieve orderbook for token', () => {
      // #given
      const orderbook: Orderbook = {
        bids: [[0.5, 100]],
        asks: [[0.55, 100]],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      };

      // #when
      manager.update('token1', orderbook);
      const result = manager.get('token1');

      // #then
      expect(result).toEqual(orderbook);
    });

    it('should return undefined for non-existent token', () => {
      // #given
      const tokenId = 'nonexistent';

      // #when
      const result = manager.get(tokenId);

      // #then
      expect(result).toBeUndefined();
    });
  });

  describe('getBestBidAsk', () => {
    it('should return best bid and ask for token', () => {
      // #given
      const orderbook: Orderbook = {
        bids: [
          [0.48, 100],
          [0.5, 100],
        ],
        asks: [
          [0.52, 100],
          [0.55, 100],
        ],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      };
      manager.update('token1', orderbook);

      // #when
      const [bid, ask] = manager.getBestBidAsk('token1');

      // #then
      expect(bid).toBe(0.48);
      expect(ask).toBe(0.52);
    });

    it('should return nulls for non-existent token', () => {
      // #given / #when
      const [bid, ask] = manager.getBestBidAsk('nonexistent');

      // #then
      expect(bid).toBeNull();
      expect(ask).toBeNull();
    });
  });

  describe('hasData', () => {
    it('should return true when orderbook has bids and asks', () => {
      // #given
      const orderbook: Orderbook = {
        bids: [[0.5, 100]],
        asks: [[0.55, 100]],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      };
      manager.update('token1', orderbook);

      // #when
      const result = manager.hasData('token1');

      // #then
      expect(result).toBe(true);
    });

    it('should return false when orderbook is empty', () => {
      // #given
      const orderbook: Orderbook = {
        bids: [],
        asks: [],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      };
      manager.update('token1', orderbook);

      // #when
      const result = manager.hasData('token1');

      // #then
      expect(result).toBe(false);
    });
  });

  describe('hasAllData', () => {
    it('should return true when all tokens have data', () => {
      // #given
      manager.update('token1', {
        bids: [[0.5, 100]],
        asks: [[0.55, 100]],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      });
      manager.update('token2', {
        bids: [[0.4, 100]],
        asks: [[0.45, 100]],
        timestamp: Date.now(),
        assetId: 'token2',
        marketId: 'm1',
      });

      // #when
      const result = manager.hasAllData(['token1', 'token2']);

      // #then
      expect(result).toBe(true);
    });

    it('should return false when some tokens lack data', () => {
      // #given
      manager.update('token1', {
        bids: [[0.5, 100]],
        asks: [[0.55, 100]],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      });

      // #when
      const result = manager.hasAllData(['token1', 'token2']);

      // #then
      expect(result).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all orderbooks', () => {
      // #given
      manager.update('token1', {
        bids: [],
        asks: [],
        timestamp: Date.now(),
        assetId: 'token1',
        marketId: 'm1',
      });
      manager.update('token2', {
        bids: [],
        asks: [],
        timestamp: Date.now(),
        assetId: 'token2',
        marketId: 'm1',
      });

      // #when
      manager.clear();

      // #then
      expect(manager.get('token1')).toBeUndefined();
      expect(manager.get('token2')).toBeUndefined();
    });
  });
});
