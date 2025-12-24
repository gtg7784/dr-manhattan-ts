export class DrManhattanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrManhattanError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ExchangeError extends DrManhattanError {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeError';
  }
}

export class NetworkError extends DrManhattanError {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class RateLimitError extends DrManhattanError {
  retryAfter: number | undefined;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class AuthenticationError extends DrManhattanError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class InsufficientFunds extends DrManhattanError {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFunds';
  }
}

export class InvalidOrder extends DrManhattanError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrder';
  }
}

export class MarketNotFound extends DrManhattanError {
  constructor(message: string) {
    super(message);
    this.name = 'MarketNotFound';
  }
}
