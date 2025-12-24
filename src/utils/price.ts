export function roundToTickSize(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

export function clampPrice(price: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, price));
}

export function formatPrice(price: number, decimals = 4): string {
  return price.toFixed(decimals);
}

export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
