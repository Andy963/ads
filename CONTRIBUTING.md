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

- Node.js 18 or newer
- npm or yarn
- Git

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/ads.git
   cd ads
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a `.env.telegram` file based on `.env.example` (if working on Telegram features)
5. Build the project:
   ```bash
   npm run build
   ```

## Development Workflow

### Running in Development Mode

```bash
npm run dev
```

This runs the server in watch mode, automatically rebuilding on file changes.

### Running Tests

```bash
npm test
```

### Building

```bash
npm run build
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
   npm test
   npm run build
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
- Place tests in the `tests/` directory
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
├── src/           # Source code
│   ├── tools/     # MCP tool implementations
│   ├── graph/     # Graph/workflow logic
│   ├── workspace/ # Workspace management
│   ├── telegram/  # Telegram bot
│   └── templates/ # Template rendering
├── tests/         # Test files
├── templates/     # Workspace templates
├── scripts/       # Build and utility scripts
└── docs/          # Documentation
```

## Questions?

- Check existing issues and discussions
- Open a new issue for bugs or feature requests
- Join discussions for questions and ideas

## License

By contributing to ADS, you agree that your contributions will be licensed under the MIT License.
