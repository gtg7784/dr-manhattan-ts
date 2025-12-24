/**
 * Position-related types for tracking holdings.
 */

/** Represents a position in a prediction market */
export interface Position {
  /** Market identifier */
  marketId: string;
  /** Outcome held */
  outcome: string;
  /** Position size (number of shares) */
  size: number;
  /** Average entry price */
  averagePrice: number;
  /** Current market price */
  currentPrice: number;
}

/** Helper functions for Position */
export const PositionUtils = {
  /** Get total cost basis */
  costBasis(position: Position): number {
    return position.size * position.averagePrice;
  },

  /** Get current market value */
  currentValue(position: Position): number {
    return position.size * position.currentPrice;
  },

  /** Get unrealized profit/loss */
  unrealizedPnl(position: Position): number {
    return PositionUtils.currentValue(position) - PositionUtils.costBasis(position);
  },

  /** Get unrealized P&L as percentage */
  unrealizedPnlPercent(position: Position): number {
    const costBasis = PositionUtils.costBasis(position);
    if (costBasis === 0) return 0;
    return (PositionUtils.unrealizedPnl(position) / costBasis) * 100;
  },
} as const;

/** Aggregated position info for delta calculations */
export interface DeltaInfo {
  /** Net delta (positive = long bias) */
  delta: number;
  /** Outcome with maximum position */
  maxOutcome: string | null;
  /** Maximum position size */
  maxPosition: number;
}

/** Calculate delta from positions map */
export function calculateDelta(positions: Record<string, number>): DeltaInfo {
  const entries = Object.entries(positions);
  if (entries.length === 0) {
    return { delta: 0, maxOutcome: null, maxPosition: 0 };
  }

  let maxOutcome: string | null = null;
  let maxPosition = 0;

  for (const [outcome, size] of entries) {
    if (size > maxPosition) {
      maxPosition = size;
      maxOutcome = outcome;
    }
  }

  if (entries.length === 2) {
    const [first, second] = entries;
    if (first && second) {
      const delta = Math.abs(first[1] - second[1]);
      return { delta, maxOutcome, maxPosition };
    }
  }

  return { delta: maxPosition, maxOutcome, maxPosition };
}
