import { describe, expect, it } from 'vitest';
import { Limitless, Opinion, Polymarket, createExchange, listExchanges } from '../src/index.js';

describe('listExchanges', () => {
  it('should return all available exchange ids', () => {
    // #given
    const expectedExchanges = ['polymarket', 'opinion', 'limitless'];

    // #when
    const result = listExchanges();

    // #then
    expect(result).toEqual(expectedExchanges);
  });
});

describe('createExchange', () => {
  it('should create Polymarket instance', () => {
    // #given
    const exchangeId = 'polymarket';

    // #when
    const exchange = createExchange(exchangeId);

    // #then
    expect(exchange).toBeInstanceOf(Polymarket);
    expect(exchange.id).toBe('polymarket');
  });

  it('should create exchange case-insensitively', () => {
    // #given
    const exchangeId = 'POLYMARKET';

    // #when
    const exchange = createExchange(exchangeId);

    // #then
    expect(exchange).toBeInstanceOf(Polymarket);
  });

  it('should create Opinion instance', () => {
    // #given
    const exchangeId = 'opinion';

    // #when
    const exchange = createExchange(exchangeId);

    // #then
    expect(exchange).toBeInstanceOf(Opinion);
    expect(exchange.id).toBe('opinion');
  });

  it('should create Limitless instance', () => {
    // #given
    const exchangeId = 'limitless';

    // #when
    const exchange = createExchange(exchangeId);

    // #then
    expect(exchange).toBeInstanceOf(Limitless);
    expect(exchange.id).toBe('limitless');
  });

  it('should throw for unknown exchange', () => {
    // #given
    const exchangeId = 'unknown';

    // #when / #then
    expect(() => createExchange(exchangeId)).toThrow(
      "Exchange 'unknown' not found. Available: polymarket, opinion, limitless"
    );
  });
});

describe('Exchange instances', () => {
  describe('Polymarket', () => {
    it('should have correct describe output', () => {
      // #given
      const exchange = new Polymarket();

      // #when
      const desc = exchange.describe();

      // #then
      expect(desc.id).toBe('polymarket');
      expect(desc.name).toBe('Polymarket');
      expect(desc.has.fetchMarkets).toBe(true);
      expect(desc.has.createOrder).toBe(true);
    });

    it('should have correct id and name', () => {
      // #given / #when
      const exchange = new Polymarket();

      // #then
      expect(exchange.id).toBe('polymarket');
      expect(exchange.name).toBe('Polymarket');
    });
  });

  describe('Opinion', () => {
    it('should have correct id and name', () => {
      // #given / #when
      const exchange = new Opinion();

      // #then
      expect(exchange.id).toBe('opinion');
      expect(exchange.name).toBe('Opinion');
    });
  });

  describe('Limitless', () => {
    it('should have correct id and name', () => {
      // #given / #when
      const exchange = new Limitless();

      // #then
      expect(exchange.id).toBe('limitless');
      expect(exchange.name).toBe('Limitless');
    });

    it('should have correct describe output', () => {
      // #given
      const exchange = new Limitless();

      // #when
      const desc = exchange.describe();

      // #then
      expect(desc.id).toBe('limitless');
      expect(desc.name).toBe('Limitless');
      expect(desc.has.fetchMarkets).toBe(true);
      expect(desc.has.fetchMarket).toBe(true);
      expect(desc.has.createOrder).toBe(true);
      expect(desc.has.cancelOrder).toBe(true);
      expect(desc.has.fetchOrder).toBe(true);
      expect(desc.has.fetchOpenOrders).toBe(true);
      expect(desc.has.fetchPositions).toBe(true);
      expect(desc.has.fetchBalance).toBe(true);
      expect(desc.has.websocket).toBe(true);
    });

    it('should accept custom configuration', () => {
      // #given
      const customHost = 'https://custom.api.com';
      const customChainId = 1234;

      // #when
      const exchange = new Limitless({
        host: customHost,
        chainId: customChainId,
        verbose: true,
      });

      // #then
      expect(exchange.id).toBe('limitless');
      expect(exchange.verbose).toBe(true);
    });
  });
});
