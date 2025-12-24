import { EventEmitter } from 'node:events';
import type { Market, Order, Position } from '../types/index.js';
import type { OrderSide } from '../types/index.js';
import type { Exchange } from './exchange.js';

export const StrategyState = {
  STOPPED: 'stopped',
  RUNNING: 'running',
  PAUSED: 'paused',
} as const;
export type StrategyState = (typeof StrategyState)[keyof typeof StrategyState];

export interface StrategyConfig {
  tickInterval?: number;
  maxPositionSize?: number;
  spreadBps?: number;
  verbose?: boolean;
}

export abstract class Strategy extends EventEmitter {
  protected exchange: Exchange;
  protected marketId: string;
  protected market: Market | null = null;
  protected state: StrategyState = StrategyState.STOPPED;
  protected config: StrategyConfig;
  protected tickTimer: ReturnType<typeof setInterval> | null = null;
  protected positions: Position[] = [];
  protected openOrders: Order[] = [];

  constructor(exchange: Exchange, marketId: string, config: StrategyConfig = {}) {
    super();
    this.exchange = exchange;
    this.marketId = marketId;
    this.config = {
      tickInterval: 1000,
      maxPositionSize: 100,
      spreadBps: 100,
      verbose: false,
      ...config,
    };
  }

  abstract onTick(): Promise<void>;

  async start(): Promise<void> {
    if (this.state === StrategyState.RUNNING) return;

    this.market = await this.exchange.fetchMarket(this.marketId);
    this.state = StrategyState.RUNNING;

    this.tickTimer = setInterval(async () => {
      if (this.state !== StrategyState.RUNNING) return;

      try {
        await this.refreshState();
        await this.onTick();
      } catch (error) {
        this.emit('error', error);
        if (this.config.verbose) {
          console.error('Strategy tick error:', error);
        }
      }
    }, this.config.tickInterval);

    this.emit('started');
  }

  async stop(): Promise<void> {
    if (this.state === StrategyState.STOPPED) return;

    this.state = StrategyState.STOPPED;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    await this.cancelAllOrders();
    this.emit('stopped');
  }

  pause(): void {
    if (this.state === StrategyState.RUNNING) {
      this.state = StrategyState.PAUSED;
      this.emit('paused');
    }
  }

  resume(): void {
    if (this.state === StrategyState.PAUSED) {
      this.state = StrategyState.RUNNING;
      this.emit('resumed');
    }
  }

  protected async refreshState(): Promise<void> {
    const [positions, orders] = await Promise.all([
      this.exchange.fetchPositions(this.marketId),
      this.exchange.fetchOpenOrders(this.marketId),
    ]);
    this.positions = positions;
    this.openOrders = orders;
  }

  protected async cancelAllOrders(): Promise<void> {
    for (const order of this.openOrders) {
      try {
        await this.exchange.cancelOrder(order.id, this.marketId);
      } catch {
        void 0;
      }
    }
    this.openOrders = [];
  }

  protected getPosition(outcome: string): Position | undefined {
    return this.positions.find((p) => p.outcome === outcome);
  }

  protected getNetPosition(): number {
    if (!this.market || this.market.outcomes.length !== 2) return 0;
    const outcome1 = this.market.outcomes[0];
    const outcome2 = this.market.outcomes[1];
    if (!outcome1 || !outcome2) return 0;
    const pos1 = this.getPosition(outcome1)?.size ?? 0;
    const pos2 = this.getPosition(outcome2)?.size ?? 0;
    return pos1 - pos2;
  }

  protected async placeOrder(
    outcome: string,
    side: OrderSide,
    price: number,
    size: number,
    tokenId?: string
  ): Promise<Order | null> {
    try {
      const order = await this.exchange.createOrder({
        marketId: this.marketId,
        outcome,
        side,
        price,
        size,
        tokenId,
      });
      this.openOrders.push(order);
      this.emit('order', order);
      return order;
    } catch (error) {
      this.emit('error', error);
      return null;
    }
  }

  protected log(message: string): void {
    if (this.config.verbose) {
      console.log(`[${this.exchange.id}:${this.marketId}] ${message}`);
    }
  }

  get isRunning(): boolean {
    return this.state === StrategyState.RUNNING;
  }

  get currentState(): StrategyState {
    return this.state;
  }
}
