# Contributing to dr-manhattan

Thank you for your interest in contributing to dr-manhattan!

## Development Setup

### Prerequisites

- Node.js >= 20.0.0
- pnpm >= 9.0.0

### Getting Started

```bash
# Clone the repository
git clone https://github.com/gtg7784/dr-manhattan-ts.git
cd dr-manhattan-ts

# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm build
```

## Development Workflow

### Available Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Watch mode build |
| `pnpm build` | Production build |
| `pnpm test` | Run tests in watch mode |
| `pnpm test:run` | Run tests once |
| `pnpm lint` | Check linting |
| `pnpm lint:fix` | Fix linting issues |
| `pnpm format` | Format code |
| `pnpm typecheck` | Type check |

### Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting.

- **Indentation**: 2 spaces
- **Quotes**: Single quotes
- **Semicolons**: Always
- **Trailing commas**: ES5 style
- **Line width**: 100 characters

Run `pnpm lint:fix` before committing to auto-fix issues.

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Ensure all checks pass:
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test:run
   pnpm build
   ```
5. Commit your changes with a descriptive message
6. Push to your fork and open a Pull Request

### Commit Messages

Use clear, descriptive commit messages:

- `feat: add support for new exchange`
- `fix: resolve orderbook sync issue`
- `docs: update API reference`
- `refactor: simplify market utils`
- `test: add tests for position utils`

## Adding a New Exchange

1. Create a new directory under `src/exchanges/<exchange-name>/`

2. Implement the `Exchange` abstract class:

```typescript
// src/exchanges/<exchange-name>/index.ts
import { Exchange, type ExchangeConfig, type Market } from '../../core/exchange';

export class NewExchange extends Exchange {
  readonly id = 'newexchange';
  readonly name = 'New Exchange';

  async fetchMarkets(params?: FetchMarketsParams): Promise<Market[]> {
    // Implementation
  }

  async fetchMarket(marketId: string): Promise<Market> {
    // Implementation
  }

  // Implement other abstract methods...
}
```

3. Export from `src/exchanges/index.ts`

4. Add to `EXCHANGES` map in `src/exchanges/index.ts`

5. Add tests in `tests/`

6. Update README.md with the new exchange

## Testing

Tests are written using [Vitest](https://vitest.dev/).

```typescript
import { describe, it, expect } from 'vitest';

describe('NewExchange', () => {
  it('should fetch markets', async () => {
    // #given
    const exchange = new NewExchange();

    // #when
    const markets = await exchange.fetchMarkets();

    // #then
    expect(markets).toBeDefined();
    expect(Array.isArray(markets)).toBe(true);
  });
});
```

### Test Structure

Use `#given`, `#when`, `#then` comments to structure tests clearly.

## Reporting Issues

When opening an issue, please include:

- Node.js version (`node --version`)
- pnpm version (`pnpm --version`)
- Reproduction steps
- Expected vs actual behavior
- Error messages (if any)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
