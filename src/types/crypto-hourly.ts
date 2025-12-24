export type MarketDirection = 'up' | 'down';
export type CryptoMarketType = 'up_down' | 'strike_price';

export interface CryptoHourlyMarket {
  tokenSymbol: string;
  expiryTime: Date;
  strikePrice: number | null;
  direction?: MarketDirection;
  marketType?: CryptoMarketType;
}

export const TOKEN_ALIASES: Record<string, string> = {
  BITCOIN: 'BTC',
  ETHEREUM: 'ETH',
  SOLANA: 'SOL',
};

export function normalizeTokenSymbol(token: string): string {
  const upper = token.toUpperCase();
  return TOKEN_ALIASES[upper] ?? upper;
}
