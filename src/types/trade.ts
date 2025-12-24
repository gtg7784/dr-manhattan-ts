export interface PublicTrade {
  proxyWallet: string;
  side: string;
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: Date;
  title?: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
  profileImageOptimized?: string;
  transactionHash?: string;
}

export interface PricePoint {
  timestamp: Date;
  price: number;
  raw: Record<string, unknown>;
}

export interface Tag {
  id: string;
  label?: string;
  slug?: string;
  forceShow?: boolean;
  forceHide?: boolean;
  isCarousel?: boolean;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  raw: Record<string, unknown>;
}

export type PriceHistoryInterval = '1m' | '1h' | '6h' | '1d' | '1w' | 'max';
