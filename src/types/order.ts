/**
 * Order-related types for prediction market trading.
 */

/** Order side - buy or sell */
export const OrderSide = {
  BUY: 'buy',
  SELL: 'sell',
} as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

/** Order status */
export const OrderStatus = {
  PENDING: 'pending',
  OPEN: 'open',
  FILLED: 'filled',
  PARTIALLY_FILLED: 'partially_filled',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** Order representation */
export interface Order {
  /** Unique order identifier */
  id: string;
  /** Market identifier */
  marketId: string;
  /** Outcome being traded */
  outcome: string;
  /** Buy or sell */
  side: OrderSide;
  /** Price per share (0-1) */
  price: number;
  /** Total order size */
  size: number;
  /** Amount filled */
  filled: number;
  /** Current status */
  status: OrderStatus;
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt?: Date;
}

/** Helper functions for Order */
export const OrderUtils = {
  /** Get remaining unfilled amount */
  remaining(order: Order): number {
    return order.size - order.filled;
  },

  /** Check if order is still active */
  isActive(order: Order): boolean {
    return order.status === OrderStatus.OPEN || order.status === OrderStatus.PARTIALLY_FILLED;
  },

  /** Check if order is completely filled */
  isFilled(order: Order): boolean {
    return order.status === OrderStatus.FILLED || order.filled >= order.size;
  },

  /** Get fill percentage (0-1) */
  fillPercentage(order: Order): number {
    if (order.size === 0) return 0;
    return order.filled / order.size;
  },
} as const;

/** Parameters for creating a new order */
export interface CreateOrderParams {
  marketId: string;
  outcome: string;
  side: OrderSide;
  price: number;
  size: number;
  /** Token ID (required for some exchanges) */
  tokenId?: string;
  /** Additional exchange-specific parameters */
  params?: Record<string, unknown>;
}
