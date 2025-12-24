import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Market,
  MarketNotFound,
  MarketUtils,
  NetworkError,
  Polymarket,
} from '../src/index.js';

const createMockMarket = (overrides: Partial<Market> = {}): Market => ({
  id: 'cond-123',
  question: 'Will BTC reach $100k?',
  description: 'Market for BTC price prediction',
  outcomes: ['Yes', 'No'],
  prices: { Yes: 0.65, No: 0.35 },
  volume: 1000000,
  liquidity: 50000,
  tickSize: 0.01,
  closeTime: new Date('2025-12-31T00:00:00Z'),
  metadata: {
    active: true,
    closed: false,
    clobTokenIds: ['token-yes-123', 'token-no-123'],
    market_slug: 'btc-100k',
  },
  ...overrides,
});

describe('MarketUtils', () => {
  describe('isBinary', () => {
    it('should return true for binary market', () => {
      // #given
      const market = createMockMarket();

      // #when
      const result = MarketUtils.isBinary(market);

      // #then
      expect(result).toBe(true);
    });

    it('should return false for non-binary market', () => {
      // #given
      const market = createMockMarket({
        outcomes: ['Option A', 'Option B', 'Option C'],
      });

      // #when
      const result = MarketUtils.isBinary(market);

      // #then
      expect(result).toBe(false);
    });
  });

  describe('isOpen', () => {
    it('should return true for active, non-closed market', () => {
      // #given
      const market = createMockMarket();

      // #when
      const result = MarketUtils.isOpen(market);

      // #then
      expect(result).toBe(true);
    });

    it('should return false for closed market', () => {
      // #given
      const market = createMockMarket({
        metadata: { closed: true },
      });

      // #when
      const result = MarketUtils.isOpen(market);

      // #then
      expect(result).toBe(false);
    });

    it('should return false for market past close time', () => {
      // #given
      const market = createMockMarket({
        closeTime: new Date('2020-01-01'),
        metadata: { closed: false },
      });

      // #when
      const result = MarketUtils.isOpen(market);

      // #then
      expect(result).toBe(false);
    });
  });

  describe('spread', () => {
    it('should calculate spread for binary market', () => {
      // #given
      const market = createMockMarket({
        prices: { Yes: 0.65, No: 0.35 },
      });

      // #when
      const spread = MarketUtils.spread(market);

      // #then
      expect(spread).toBeCloseTo(0.0, 2);
    });

    it('should return null for non-binary market', () => {
      // #given
      const market = createMockMarket({
        outcomes: ['A', 'B', 'C'],
      });

      // #when
      const spread = MarketUtils.spread(market);

      // #then
      expect(spread).toBeNull();
    });

    it('should detect overround when prices sum > 1', () => {
      // #given
      const market = createMockMarket({
        prices: { Yes: 0.55, No: 0.55 },
      });

      // #when
      const spread = MarketUtils.spread(market);

      // #then
      expect(spread).toBeCloseTo(0.1, 2);
    });
  });

  describe('getTokenIds', () => {
    it('should extract token ids from metadata array', () => {
      // #given
      const market = createMockMarket({
        metadata: {
          clobTokenIds: ['token-1', 'token-2'],
        },
      });

      // #when
      const tokenIds = MarketUtils.getTokenIds(market);

      // #then
      expect(tokenIds).toEqual(['token-1', 'token-2']);
    });

    it('should parse JSON string token ids', () => {
      // #given
      const market = createMockMarket({
        metadata: {
          clobTokenIds: '["token-a", "token-b"]',
        },
      });

      // #when
      const tokenIds = MarketUtils.getTokenIds(market);

      // #then
      expect(tokenIds).toEqual(['token-a', 'token-b']);
    });

    it('should return empty array when no token ids', () => {
      // #given
      const market = createMockMarket({
        metadata: {},
      });

      // #when
      const tokenIds = MarketUtils.getTokenIds(market);

      // #then
      expect(tokenIds).toEqual([]);
    });
  });

  describe('getOutcomeTokens', () => {
    it('should create outcome token pairs', () => {
      // #given
      const market = createMockMarket({
        outcomes: ['Yes', 'No'],
        metadata: {
          clobTokenIds: ['token-yes', 'token-no'],
        },
      });

      // #when
      const tokens = MarketUtils.getOutcomeTokens(market);

      // #then
      expect(tokens).toEqual([
        { outcome: 'Yes', tokenId: 'token-yes' },
        { outcome: 'No', tokenId: 'token-no' },
      ]);
    });
  });
});

describe('Polymarket instance', () => {
  describe('calculateImpliedProbability', () => {
    it('should return price as probability within bounds', () => {
      // #given
      const polymarket = new Polymarket();

      // #when / #then
      expect(polymarket.calculateImpliedProbability(0.5)).toBe(0.5);
      expect(polymarket.calculateImpliedProbability(0.0)).toBe(0);
      expect(polymarket.calculateImpliedProbability(1.0)).toBe(1);
    });

    it('should clamp values outside 0-1 range', () => {
      // #given
      const polymarket = new Polymarket();

      // #when / #then
      expect(polymarket.calculateImpliedProbability(1.5)).toBe(1);
      expect(polymarket.calculateImpliedProbability(-0.5)).toBe(0);
    });
  });

  describe('calculateSpread', () => {
    it('should delegate to MarketUtils.spread', () => {
      // #given
      const polymarket = new Polymarket();
      const market = createMockMarket({
        prices: { Yes: 0.6, No: 0.4 },
      });

      // #when
      const spread = polymarket.calculateSpread(market);

      // #then
      expect(spread).toBeCloseTo(0.0, 2);
    });
  });

  describe('calculateExpectedValue', () => {
    it('should calculate EV for buy outcome', () => {
      // #given
      const polymarket = new Polymarket();
      const market = createMockMarket();

      // #when
      const ev = polymarket.calculateExpectedValue(market, 'Yes', 0.65);

      // #then
      expect(ev).toBeDefined();
    });
  });

  describe('getOptimalOrderSize', () => {
    it('should limit order size based on liquidity', () => {
      // #given
      const polymarket = new Polymarket();
      const market = createMockMarket({ liquidity: 10000 });

      // #when
      const size = polymarket.getOptimalOrderSize(market, 5000);

      // #then
      expect(size).toBeLessThanOrEqual(5000);
      expect(size).toBeLessThanOrEqual(1000);
    });
  });

  describe('describe', () => {
    it('should return exchange capabilities', () => {
      // #given
      const polymarket = new Polymarket();

      // #when
      const desc = polymarket.describe();

      // #then
      expect(desc.id).toBe('polymarket');
      expect(desc.name).toBe('Polymarket');
      expect(desc.has.fetchMarkets).toBe(true);
      expect(desc.has.createOrder).toBe(true);
      expect(desc.has.websocket).toBe(true);
    });
  });
});

describe('Polymarket with mocked fetch', () => {
  let polymarket: Polymarket;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    polymarket = new Polymarket({ timeout: 5000, maxRetries: 0 });
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('fetchMarket error handling', () => {
    it('should throw MarketNotFound on 404', async () => {
      // #given
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      // #when / #then
      await expect(polymarket.fetchMarket('non-existent')).rejects.toThrow(MarketNotFound);
    });

    it('should throw NetworkError on server error', async () => {
      // #given
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      // #when / #then
      await expect(polymarket.fetchMarket('test-id')).rejects.toThrow(NetworkError);
    });
  });
});

describe('Error classes', () => {
  it('NetworkError should have correct name', () => {
    // #given / #when
    const error = new NetworkError('test');

    // #then
    expect(error.name).toBe('NetworkError');
    expect(error.message).toBe('test');
  });

  it('MarketNotFound should have correct name', () => {
    // #given / #when
    const error = new MarketNotFound('test');

    // #then
    expect(error.name).toBe('MarketNotFound');
    expect(error.message).toBe('test');
  });
});
