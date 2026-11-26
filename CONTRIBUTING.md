# Contributing to ADS

Thank you for your interest in contributing to ADS! This document provides guidelines and instructions for contributing.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Documentation](#documentation)

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for all contributors.

## Getting Started

### Prerequisites

- Rust 1.85 or newer (`cargo`, `rustfmt`, `clippy`)
- Node.js 24 or newer (for `client/`)
- npm or yarn
- Git

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/ads.git
   cd ads
   ```
3. Install package-local dependencies:
   ```bash
   npm ci --prefix client
   ```
4. Create a `.env` file based on `.env.example` (shared by Telegram/Web)
5. Build the project:
   ```bash
   npm --prefix client run build
   cargo build --manifest-path rust-server/Cargo.toml -p ads-server -p ads-telegram
   ```

## Development Workflow

### Running in Development Mode

```bash
cargo run --manifest-path rust-server/Cargo.toml -p ads-server
npm --prefix client run dev
```

This starts the Rust backend alongside the Vite hot-reload client dev server.

### Running Tests

```bash
cargo test --manifest-path rust-server/Cargo.toml --workspace -- --test-threads=2
npm --prefix client test
```

### Building

```bash
npm --prefix client run build
cargo build --manifest-path rust-server/Cargo.toml --release -p ads-server -p ads-telegram
```

## Pull Request Process

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**:
   - Write clear, concise commit messages
   - Follow the coding standards (see below)
   - Add tests for new functionality
   - Update documentation as needed

3. **Test your changes**:
   ```bash
   cargo test --manifest-path rust-server/Cargo.toml --workspace -- --test-threads=2
   npm --prefix client test
   npm --prefix client run build
   ```

4. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

5. **Open a Pull Request**:
   - Provide a clear description of the changes
   - Reference any related issues
   - Ensure all CI checks pass

6. **Code Review**:
   - Address reviewer feedback
   - Keep the PR focused and reasonably sized
   - Be responsive to comments

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Prefer explicit types over `any`
- Use interfaces for object shapes
- Document complex functions with JSDoc comments

### Code Style

- Use 2 spaces for indentation
- Use single quotes for strings
- Add trailing commas in multi-line objects/arrays
- Keep line length under 100 characters when reasonable

### Naming Conventions

- Use `camelCase` for variables and functions
- Use `PascalCase` for classes and interfaces
- Use `UPPER_CASE` for constants
- Use descriptive names that convey intent

### Example

```typescript
interface UserConfig {
  apiKey: string;
  maxRetries: number;
}

export function loadConfig(path: string): UserConfig {
  // Implementation
}
```

## Testing

- Write tests for new features and bug fixes
- Place backend tests under `rust-server/crates/<crate>/tests/` and client tests under `client/src/__tests__/`
- Use descriptive test names
- Aim for high code coverage on critical paths

### Test Structure

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Feature Name', () => {
  it('should do something specific', () => {
    // Test implementation
    assert.strictEqual(actual, expected);
  });
});
```

## Documentation

- Update README.md for user-facing changes
- Add JSDoc comments for public APIs
- Update relevant docs in `docs/` directory
- Include examples for new features

### Documentation Files

- `README.md` - Main project documentation
- `docs/USAGE_GUIDE.md` - Detailed usage instructions
- `docs/telegram/` - Telegram bot documentation
- `docs/CODEX.md` - Codex integration guide

## Project Structure

```
ads/
├── client/        # Shared frontend (Vue 3, Vite)
├── rust-server/   # Active Rust backend and connector crates
└── docs/          # Documentation
```

## Questions?

- Check existing issues and discussions
- Open a new issue for bugs or feature requests
- Join discussions for questions and ideas

## License

By contributing to ADS, you agree that your contributions will be licensed under the MIT License.
