import { describe, expect, it } from 'vitest';
import {
  calculateDelta,
  type Market,
  MarketUtils,
  type Order,
  OrderSide,
  OrderStatus,
  OrderUtils,
  type Position,
  PositionUtils,
} from '../src/index.js';

describe('OrderSide', () => {
  it('should have BUY and SELL values', () => {
    // #given
    const expectedBuy = 'buy';
    const expectedSell = 'sell';

    // #when
    const actualBuy = OrderSide.BUY;
    const actualSell = OrderSide.SELL;

    // #then
    expect(actualBuy).toBe(expectedBuy);
    expect(actualSell).toBe(expectedSell);
  });
});

describe('OrderStatus', () => {
  it('should have all status values', () => {
    // #given
    const expectedStatuses = [
      'pending',
      'open',
      'filled',
      'partially_filled',
      'cancelled',
      'rejected',
    ];

    // #when
    const actualStatuses = [
      OrderStatus.PENDING,
      OrderStatus.OPEN,
      OrderStatus.FILLED,
      OrderStatus.PARTIALLY_FILLED,
      OrderStatus.CANCELLED,
      OrderStatus.REJECTED,
    ];

    // #then
    expect(actualStatuses).toEqual(expectedStatuses);
  });
});

describe('OrderUtils', () => {
  describe('isActive', () => {
    it('should return true for open orders', () => {
      // #given
      const order = { status: OrderStatus.OPEN } as Order;

      // #when
      const result = OrderUtils.isActive(order);

      // #then
      expect(result).toBe(true);
    });

    it('should return true for partially filled orders', () => {
      // #given
      const order = { status: OrderStatus.PARTIALLY_FILLED } as Order;

      // #when
      const result = OrderUtils.isActive(order);

      // #then
      expect(result).toBe(true);
    });

    it('should return false for filled orders', () => {
      // #given
      const order = { status: OrderStatus.FILLED } as Order;

      // #when
      const result = OrderUtils.isActive(order);

      // #then
      expect(result).toBe(false);
    });
  });

  describe('remaining', () => {
    it('should calculate remaining amount correctly', () => {
      // #given
      const order = { size: 100, filled: 25 } as Order;

      // #when
      const result = OrderUtils.remaining(order);

      // #then
      expect(result).toBe(75);
    });
  });

  describe('fillPercentage', () => {
    it('should calculate fill percentage correctly', () => {
      // #given
      const order = { size: 100, filled: 25 } as Order;

      // #when
      const result = OrderUtils.fillPercentage(order);

      // #then
      expect(result).toBe(0.25);
    });

    it('should return 0 for zero size order', () => {
      // #given
      const order = { size: 0, filled: 0 } as Order;

      // #when
      const result = OrderUtils.fillPercentage(order);

      // #then
      expect(result).toBe(0);
    });
  });

  describe('isFilled', () => {
    it('should return true for filled orders', () => {
      // #given
      const order = { status: OrderStatus.FILLED, size: 100, filled: 100 } as Order;

      // #when
      const result = OrderUtils.isFilled(order);

      // #then
      expect(result).toBe(true);
    });

    it('should return true when filled equals size', () => {
      // #given
      const order = { status: OrderStatus.OPEN, size: 100, filled: 100 } as Order;

      // #when
      const result = OrderUtils.isFilled(order);

      // #then
      expect(result).toBe(true);
    });
  });
});

describe('MarketUtils', () => {
  describe('isBinary', () => {
    it('should return true for binary markets', () => {
      // #given
      const market = { outcomes: ['Yes', 'No'] } as Market;

      // #when
      const result = MarketUtils.isBinary(market);

      // #then
      expect(result).toBe(true);
    });

    it('should return false for multi-outcome markets', () => {
      // #given
      const market = { outcomes: ['A', 'B', 'C'] } as Market;

      // #when
      const result = MarketUtils.isBinary(market);

      // #then
      expect(result).toBe(false);
    });
  });

  describe('isOpen', () => {
    it('should return true when closeTime is in the future', () => {
      // #given
      const futureDate = new Date(Date.now() + 86400000);
      const market = { closeTime: futureDate, metadata: {} } as Market;

      // #when
      const result = MarketUtils.isOpen(market);

      // #then
      expect(result).toBe(true);
    });

    it('should return false when market is marked closed', () => {
      // #given
      const market = { metadata: { closed: true } } as unknown as Market;

      // #when
      const result = MarketUtils.isOpen(market);

      // #then
      expect(result).toBe(false);
    });
  });

  describe('getTokenIds', () => {
    it('should return token ids from metadata array', () => {
      // #given
      const market = { metadata: { clobTokenIds: ['token1', 'token2'] } } as unknown as Market;

      // #when
      const result = MarketUtils.getTokenIds(market);

      // #then
      expect(result).toEqual(['token1', 'token2']);
    });

    it('should return empty array when no token ids', () => {
      // #given
      const market = { metadata: {} } as Market;

      // #when
      const result = MarketUtils.getTokenIds(market);

      // #then
      expect(result).toEqual([]);
    });
  });
});

describe('PositionUtils', () => {
  describe('costBasis', () => {
    it('should calculate cost basis correctly', () => {
      // #given
      const position = { size: 100, averagePrice: 0.65 } as Position;

      // #when
      const result = PositionUtils.costBasis(position);

      // #then
      expect(result).toBe(65);
    });
  });

  describe('currentValue', () => {
    it('should calculate current value correctly', () => {
      // #given
      const position = { size: 100, currentPrice: 0.7 } as Position;

      // #when
      const result = PositionUtils.currentValue(position);

      // #then
      expect(result).toBe(70);
    });
  });

  describe('unrealizedPnl', () => {
    it('should calculate positive PnL correctly', () => {
      // #given
      const position = { size: 100, averagePrice: 0.5, currentPrice: 0.7 } as Position;

      // #when
      const result = PositionUtils.unrealizedPnl(position);

      // #then
      expect(result).toBe(20);
    });

    it('should calculate negative PnL correctly', () => {
      // #given
      const position = { size: 100, averagePrice: 0.7, currentPrice: 0.5 } as Position;

      // #when
      const result = PositionUtils.unrealizedPnl(position);

      // #then
      expect(result).toBe(-20);
    });
  });
});

describe('calculateDelta', () => {
  it('should calculate delta for binary positions', () => {
    // #given
    const positions: Record<string, number> = {
      Yes: 100,
      No: 50,
    };

    // #when
    const result = calculateDelta(positions);

    // #then
    expect(result.delta).toBe(50);
    expect(result.maxOutcome).toBe('Yes');
    expect(result.maxPosition).toBe(100);
  });

  it('should identify balanced positions', () => {
    // #given
    const positions: Record<string, number> = {
      Yes: 100,
      No: 100,
    };

    // #when
    const result = calculateDelta(positions);

    // #then
    expect(result.delta).toBe(0);
  });

  it('should handle empty positions', () => {
    // #given
    const positions: Record<string, number> = {};

    // #when
    const result = calculateDelta(positions);

    // #then
    expect(result.delta).toBe(0);
    expect(result.maxOutcome).toBeNull();
    expect(result.maxPosition).toBe(0);
  });
});
