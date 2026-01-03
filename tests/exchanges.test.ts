import { describe, expect, it } from 'vitest';
import {
  createExchange,
  Kalshi,
  Limitless,
  listExchanges,
  Opinion,
  Polymarket,
  PredictFun,
} from '../src/index.js';

describe('listExchanges', () => {
  it('should return all available exchange ids', () => {
    // #given
    const expectedExchanges = ['polymarket', 'opinion', 'limitless', 'kalshi', 'predictfun'];

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

  it('should create Kalshi instance', () => {
    // #given
    const exchangeId = 'kalshi';

    // #when
    const exchange = createExchange(exchangeId);

    // #then
    expect(exchange).toBeInstanceOf(Kalshi);
    expect(exchange.id).toBe('kalshi');
  });

  it('should create PredictFun instance', () => {
    // #given
    const exchangeId = 'predictfun';

    // #when
    const exchange = createExchange(exchangeId);

    // #then
    expect(exchange).toBeInstanceOf(PredictFun);
    expect(exchange.id).toBe('predictfun');
  });

  it('should throw for unknown exchange', () => {
    // #given
    const exchangeId = 'unknown';

    // #when / #then
    expect(() => createExchange(exchangeId)).toThrow(
      "Exchange 'unknown' not found. Available: polymarket, opinion, limitless, kalshi, predictfun"
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

  describe('Kalshi', () => {
    it('should have correct id and name', () => {
      // #given / #when
      const exchange = new Kalshi();

      // #then
      expect(exchange.id).toBe('kalshi');
      expect(exchange.name).toBe('Kalshi');
    });

    it('should have correct describe output', () => {
      // #given
      const exchange = new Kalshi();

      // #when
      const desc = exchange.describe();

      // #then
      expect(desc.id).toBe('kalshi');
      expect(desc.name).toBe('Kalshi');
      expect(desc.has.fetchMarkets).toBe(true);
      expect(desc.has.fetchMarket).toBe(true);
      expect(desc.has.createOrder).toBe(true);
      expect(desc.has.cancelOrder).toBe(true);
      expect(desc.has.fetchOrder).toBe(true);
      expect(desc.has.fetchOpenOrders).toBe(true);
      expect(desc.has.fetchPositions).toBe(true);
      expect(desc.has.fetchBalance).toBe(true);
      expect(desc.has.websocket).toBe(false);
    });

    it('should accept custom configuration', () => {
      // #given
      const customApiUrl = 'https://custom.kalshi.com';

      // #when
      const exchange = new Kalshi({
        apiUrl: customApiUrl,
        demo: true,
        verbose: true,
      });

      // #then
      expect(exchange.id).toBe('kalshi');
      expect(exchange.verbose).toBe(true);
    });

    it('should use demo URL when demo is true', () => {
      // #given / #when
      const exchange = new Kalshi({ demo: true });

      // #then
      expect(exchange.id).toBe('kalshi');
      expect(exchange.name).toBe('Kalshi');
    });
  });

  describe('PredictFun', () => {
    it('should have correct id and name', () => {
      // #given / #when
      const exchange = new PredictFun();

      // #then
      expect(exchange.id).toBe('predictfun');
      expect(exchange.name).toBe('Predict.fun');
    });

    it('should have correct describe output', () => {
      // #given
      const exchange = new PredictFun();

      // #when
      const desc = exchange.describe();

      // #then
      expect(desc.id).toBe('predictfun');
      expect(desc.name).toBe('Predict.fun');
      expect(desc.has.fetchMarkets).toBe(true);
      expect(desc.has.fetchMarket).toBe(true);
      expect(desc.has.createOrder).toBe(true);
      expect(desc.has.cancelOrder).toBe(true);
      expect(desc.has.fetchOrder).toBe(true);
      expect(desc.has.fetchOpenOrders).toBe(true);
      expect(desc.has.fetchPositions).toBe(true);
      expect(desc.has.fetchBalance).toBe(true);
      expect(desc.has.websocket).toBe(false);
    });

    it('should accept custom configuration', () => {
      // #given
      const customHost = 'https://custom.predict.fun';

      // #when
      const exchange = new PredictFun({
        host: customHost,
        testnet: true,
        verbose: true,
      });

      // #then
      expect(exchange.id).toBe('predictfun');
      expect(exchange.verbose).toBe(true);
    });

    it('should use testnet URL when testnet is true', () => {
      // #given / #when
      const exchange = new PredictFun({ testnet: true });

      // #then
      expect(exchange.id).toBe('predictfun');
      expect(exchange.name).toBe('Predict.fun');
    });
  });
});
